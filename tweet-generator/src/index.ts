import { startOfDayIn } from 'shared/clock'
import { createPool } from 'shared/db'
import { formatError } from 'shared/errors'
import { createLogger } from 'shared/logger'
import { notifyFailure } from 'shared/notifier'
import { loadConfig } from './config.js'
import { cleanupMedia, mediaPathFor, renderCard } from './image/render.js'
import { pickVariant, renderTemplate } from './image/template.js'
import { ARCHETYPES, pickArchetype } from './llm/archetypes.js'
import { LlmClient } from 'shared/llm'
import {
  generateTweet,
  GenerationGaveUp,
  type PipelineResult,
} from './llm/pipeline.js'
import { loadBannedPhrases, type BannedPhrases } from './llm/validate.js'
import { shouldReplenish, waitAfterMs, type CycleOutcome } from './pace.js'
import { selectCandidate, type PoolDeps } from './select/pool.js'
import { orderTiers } from './select/quota.js'
import {
  fastRetryDelayMs,
  retryAfterMsOfError,
  retryPolicyOf,
  shouldAlert,
} from 'shared/retry'
import { AgentLensClient, AgentLensError } from './sources/agentlens.js'
import { GeneratorStore } from './store.js'

const logger = createLogger('tweet-generator.log')
const config = loadConfig()
const pool = createPool(config.db)
const store = new GeneratorStore(pool)
const agentlens = new AgentLensClient(config.agentlensBaseUrl)
const llm = new LlmClient(config.llm)

/** Loaded once, on the first cycle that needs it. */
let banned: BannedPhrases | null = null

/**
 * Unlike the archetype, this is not worth a database column: repeating a
 * card style is far less visible than repeating a post shape, and losing the
 * value on restart costs nothing.
 */
let lastVariant: string | null = null

const deps: PoolDeps = {
  listBlogs: (jobType, limit) => agentlens.listBlogs(jobType, limit),
  getBlog: (id) => agentlens.getBlog(id),
  // A repo that has left the leaderboard 404s here, which is ordinary: the
  // dispatch is still worth posting, it just goes out without star counts.
  // Any other failure is a real one and belongs to the cycle's error path.
  getProject: async (id) => {
    try {
      return await agentlens.getProject(id)
    } catch (error) {
      if (error instanceof AgentLensError && /returned 404/.test(error.message)) {
        return null
      }
      throw error
    }
  },
  knownDedupeKeys: (keys) => store.knownDedupeKeys(keys),
  failureCounts: (ids) => store.failureCounts(ids),
}

let stopping = false
let consecutiveSourceFailures = 0
/** Latched, so a quiet week produces one alert rather than eighty. */
let alertedIdle = false
/** Latched for the same reason: the poll is frequent, the news is not. */
let loggedStocked = false

/** Sleeps, but wakes early on shutdown. */
async function sleep(ms: number): Promise<void> {
  const step = 1000
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(step, ms - elapsed)),
    )
    elapsed += step
  }
}

/**
 * Warns when the queue has gained nothing for a day *and* is short.
 *
 * Every other alert fires on something going wrong. This one fires on nothing
 * happening at all — a niche gate that rejects everything, or a quota
 * misconfiguration, produces no errors and no posts, and would otherwise be
 * noticed only by the absence of tweets.
 *
 * The buffer clause is what keeps that honest now that production follows
 * consumption. A full queue with no new rows is the healthy shape: x-poster
 * has stopped taking them, so this service correctly stops making them.
 * Alerting on it would name the generator while the broken service is the
 * poster, and an alert pointing at the wrong half is worse than silence.
 */
async function checkIdleWatchdog(now: Date, pending: number): Promise<void> {
  const last = await store.lastEnqueuedAt()
  if (!last) return
  const idleHours = (now.getTime() - last.getTime()) / 3_600_000
  if (idleHours < 24 || alertedIdle) return
  if (pending >= config.queueTarget) return

  alertedIdle = true
  await notifyFailure(
    config.discordWebhookUrl,
    'tweet-generator',
    `Nothing has been enqueued for ${Math.floor(idleHours)} hours with ` +
      `only ${pending} queued. Every pool may be empty, or the quota may ` +
      'be misconfigured.',
  )
}

async function tick(): Promise<CycleOutcome> {
  const now = new Date()

  const retentionCutoff = new Date(
    now.getTime() - config.mediaRetentionDays * 86_400_000,
  )
  const removed = await cleanupMedia(await store.expiredMedia(retentionCutoff))
  if (removed > 0) logger.info('Cleaned up old media', { removed })

  const dayStart = startOfDayIn(config.timezone, now)
  const usage = await store.usageSince(dayStart)
  const order = orderTiers(now, usage, config)

  if (order.length === 0) {
    logger.info('Nothing left to spend today', { total: usage.total })
    return 'capped'
  }

  let gaveUp = 0

  for (const tier of order) {
    const candidate = await selectCandidate(tier, now, config, deps)
    if (!candidate) {
      logger.debug('Pool empty, falling through', { tier })
      continue
    }

    banned ??= await loadBannedPhrases(config.bannedPhrasesFile)
    const archetype = pickArchetype(await store.lastArchetype())

    // Declared outside the try so the card renderer can reach the draft.
    let generated: PipelineResult
    try {
      generated = await generateTweet(candidate, archetype, {
        chat: (messages) => llm.chat(messages),
        banned,
        maxRounds: config.maxRounds,
      })
      logger.info('Generated', {
        externalId: candidate.externalId,
        archetype,
        rounds: generated.rounds,
      })
    } catch (error) {
      if (error instanceof GenerationGaveUp) {
        // The candidate stays out of the pool for good after three of these,
        // so one item the model cannot handle cannot starve its source.
        await store.recordFailure(
          candidate.externalId,
          error.violations.join('; '),
        )
        logger.warn('Gave up on a candidate', {
          externalId: candidate.externalId,
          violations: error.violations,
        })
        // On to the next kind rather than out of the cycle. Two hours is too
        // expensive to spend on one item the model cannot fit into the
        // budget, and the pools are independent — the next kind is a
        // different item, not a retry of this one. The cost stays bounded
        // because each give-up has already spent its maxRounds and the loop
        // runs over the kinds the quota allows, which is a handful.
        gaveUp += 1
        continue
      }
      throw error
    }

    let mediaPath: string | undefined
    if (ARCHETYPES[archetype].hasImage) {
      const cardArchetype = archetype as 'digest' | 'metric'
      const variant = pickVariant(cardArchetype, lastVariant)
      const path = mediaPathFor(config.mediaDir, candidate.dedupeKey)
      // A render failure abandons the whole item. Enqueueing the text alone
      // would ship a degraded post that can never be repaired, because the
      // dedupe key is spent the moment the row exists.
      await renderCard(
        renderTemplate({ draft: generated.draft, candidate, variant }),
        path,
      )
      lastVariant = variant
      mediaPath = path
      logger.debug('Rendered a card', { path, variant })
    }

    const id = await store.enqueue({
      content: generated.text,
      dedupeKey: candidate.dedupeKey,
      source: candidate.kind,
      sourceRef: candidate.externalId,
      archetype,
      mediaPath,
      tier,
      entities: candidate.entities,
    })

    if (id === null) {
      // Another process won the race, or the key was already spent. Either
      // way the buffer did not grow, so this is not a restock.
      logger.info('Already queued, skipping', { key: candidate.dedupeKey })
      return 'idle'
    }

    alertedIdle = false
    logger.info('Enqueued', {
      id,
      kind: candidate.kind,
      externalId: candidate.externalId,
    })
    return 'enqueued'
  }

  // Worth separating: an empty pool is a sourcing problem, a cycle that gave
  // up on every candidate it had is a generation problem, and the fix for one
  // is nothing like the fix for the other.
  if (gaveUp > 0) {
    logger.warn('Every candidate this cycle was given up on', { gaveUp })
  } else {
    logger.info('Every pool was empty this cycle')
  }
  return 'idle'
}

/**
 * A cycle, with the failures that clear themselves in seconds absorbed.
 *
 * Re-running the whole tick is safe because nothing durable has been written
 * when one of these throws: the only lasting write is the enqueue at the very
 * end, and reaching it means the cycle returned rather than threw. The dedupe
 * key guards the rest, and media cleanup is idempotent.
 */
async function runCycle(): Promise<CycleOutcome> {
  for (let attempt = 1; !stopping; attempt++) {
    try {
      return await tick()
    } catch (error) {
      const policy = retryPolicyOf(error)
      const delay = policy === null ? null : fastRetryDelayMs(policy, attempt)
      if (delay === null) throw error

      logger.warn('Retrying without giving up the cycle', {
        error: formatError(error),
        attempt,
        inMs: delay,
      })
      await sleep(delay)
    }
  }

  // Only reachable once shutdown has been asked for, when the caller's loop
  // is about to exit anyway. Nothing was queued, so nothing was restocked.
  return 'idle'
}

async function shutdown(reason: string, code: number): Promise<void> {
  if (stopping) return
  stopping = true
  logger.info('Shutting down', { reason })
  await pool.end().catch(() => {})
  process.exit(code)
}

async function main(): Promise<void> {
  logger.info('Starting tweet-generator', {
    model: config.llm.model,
    dailyCap: config.dailyCap,
    queueTarget: config.queueTarget,
    timezone: config.timezone,
  })

  process.on('SIGINT', () => void shutdown('SIGINT', 0))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  while (!stopping) {
    const now = new Date()
    const pending = await store.pendingCount()
    await checkIdleWatchdog(now, pending)

    if (!shouldReplenish(pending, config.queueTarget)) {
      // Said once per spell rather than every poll. Without it a stocked
      // queue makes this process completely silent — overnight that is
      // hours of nothing, which is exactly what a hung process looks like.
      if (!loggedStocked) {
        loggedStocked = true
        logger.info('Stocked, leaving the queue alone', {
          pending,
          target: config.queueTarget,
          pollMinutes: config.queuePollMinutes,
        })
      }
      await sleep(config.queuePollMinutes * 60_000)
      continue
    }

    loggedStocked = false

    // A failed cycle must never fall through to a zero wait: runCycle has
    // already spent its fast retries by the time it throws, so coming
    // straight back would spin against an upstream that is still down.
    let waitMs = config.emptyPoolMinutes * 60_000

    try {
      waitMs = waitAfterMs(await runCycle(), now, config)
      consecutiveSourceFailures = 0
    } catch (error) {
      const message = formatError(error)
      const policy = retryPolicyOf(error)

      if (policy !== null) {
        consecutiveSourceFailures += 1
        // `retry` is logged because it is the whole reason this line did not
        // become an alert: reading "never" next to a silent cycle is what
        // tells you the wait is pointless.
        logger.warn('An upstream dependency failed', {
          error: message,
          retry: policy,
          consecutive: consecutiveSourceFailures,
        })

        if (shouldAlert(policy, consecutiveSourceFailures)) {
          await notifyFailure(
            config.discordWebhookUrl,
            'tweet-generator',
            policy === 'never'
              ? `Upstream failure that cannot clear itself: ${message}`
              : `Upstream unreachable for ${consecutiveSourceFailures} cycles: ${message}`,
          )
        }

        // Only ever extends the wait. Coming back before the window the
        // server named is how a quota gets pushed out rather than reset.
        const retryAfterMs = retryAfterMsOfError(error)
        if (policy === 'quota' && retryAfterMs !== null) {
          waitMs = Math.max(waitMs, retryAfterMs)
        }
      } else {
        // Unlike x-poster, an unexpected failure here is not a reason to
        // stop: nothing has been posted, and the next cycle starts fresh.
        logger.error('Cycle failed', { error: message })
      }
    }

    // A restock returns zero, and looking again is one COUNT. Sleeping on it
    // would only put the service further behind the poster.
    if (waitMs === 0) continue

    // Logged rather than left implicit: a process that has gone quiet is
    // otherwise indistinguishable from one that has hung, and the answer is
    // only ever in these two numbers.
    logger.info('Waiting before the next look at the queue', {
      minutes: Math.round(waitMs / 60_000),
      wakesAt: new Date(Date.now() + waitMs).toISOString(),
      pending,
    })
    await sleep(waitMs)
  }
}

main().catch(async (error) => {
  const message = formatError(error)
  logger.error('Unrecoverable startup failure', { error: message })
  await notifyFailure(config.discordWebhookUrl, 'tweet-generator', message)
  await shutdown('startup failure', 1)
})
