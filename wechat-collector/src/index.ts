/**
 * The collector service. Every poll it re-reads keys.json, opens the shards it
 * has keys for, and collects each enabled group once. Re-reading the keys and
 * re-opening the shards each pass means a re-run of the extraction — after
 * WeChat adds a shard or the owner logs in again — takes effect without a
 * restart, and each pass sees the current WAL.
 *
 * It never writes to WeChat's files. It stores messages and, in a later
 * addition, embeds them.
 */
import { createPool } from 'shared/db'
import { LlmClient } from 'shared/llm'
import { createLogger } from 'shared/logger'
import { notifyAttention } from 'shared/notifier'
import { collectOnce } from './collect.js'
import { loadConfig } from './config.js'
import { loadContactNames } from './contacts.js'
import { embedPending } from './embed.js'
import { loadKeys } from './keys.js'
import { openShards } from './shards.js'
import { CollectorStore } from './store.js'
import { FailureWatch } from './watch.js'

const SERVICE = 'wechat-collector'
const FAILURE_ALERT_MS = 10 * 60_000
const EMBED_BATCH = 64

const logger = createLogger('wechat-collector.log')
const config = loadConfig()
const pool = createPool()
const store = new CollectorStore(pool)
const failures = new FailureWatch(FAILURE_ALERT_MS)

// One client, only when a model is configured. Its method is bound once so the
// embed loop passes a plain function.
const llm = config.embedding ? new LlmClient(config.embedding) : null
const embed = llm ? llm.embed.bind(llm) : null

let stopping = false
/** Missing-shard sets already reported, so the owner hears about each once. */
const reportedMissing = new Set<string>()

/** Sleep, but wake immediately on shutdown. */
async function sleep(ms: number): Promise<void> {
  const step = 500
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - elapsed)))
    elapsed += step
  }
}

async function reportMissing(missing: string[]): Promise<void> {
  const fingerprint = missing.join(',')
  if (reportedMissing.has(fingerprint)) return
  reportedMissing.add(fingerprint)
  logger.warn('Shards without a key', { missing })
  await notifyAttention(
    config.notify,
    SERVICE,
    `No key for ${missing.join(', ')}. WeChat has probably added a message ` +
      `shard. Re-run key extraction and update ${config.keysPath}; the other ` +
      `shards keep collecting meanwhile.`,
  )
}

async function tick(): Promise<void> {
  const keys = loadKeys(config.keysPath)
  const { readers, missing } = openShards(config.dbDir, keys)
  if (missing.length) await reportMissing(missing)

  // Names come from contact.db, if its key is present; otherwise messages keep
  // the username, which the store falls back to.
  const contactKey = keys.get('contact/contact.db')
  const names = contactKey ? loadContactNames(config.dbDir, contactKey) : new Map()

  try {
    const result = await collectOnce(
      readers,
      store,
      config.groups,
      new Date(),
      { overlapSeconds: config.overlapSeconds, backfillDays: config.backfillDays },
      names,
    )
    const stored = [...result.values()].reduce((sum, n) => sum + n, 0)
    if (stored > 0) logger.info('Collected', { stored, groups: result.size })
    failures.succeed()
  } finally {
    readers.forEach((reader) => reader.close())
  }

  // Embed after collecting, draining a backlog a batch at a time. A failure
  // here is logged but not fatal: the messages are stored, and the next pass
  // retries them.
  if (embed && config.embedding) {
    try {
      let embedded: number
      let total = 0
      do {
        embedded = await embedPending(embed, store, {
          minChars: config.embedding.minChars,
          batchSize: EMBED_BATCH,
        })
        total += embedded
      } while (embedded === EMBED_BATCH && !stopping)
      if (total > 0) logger.info('Embedded', { count: total })
    } catch (error) {
      logger.warn('Embedding pass failed; will retry', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

async function main(): Promise<void> {
  if (config.groups.length === 0) {
    logger.warn(
      'No groups configured. Set WECHAT_GROUPS; list them with ' +
        '`pnpm --filter wechat-collector groups`.',
    )
  }
  await store.enableGroups(config.groups)
  logger.info('Collector started', {
    groups: config.groups.length,
    pollSeconds: config.pollSeconds,
  })

  while (!stopping) {
    try {
      await tick()
    } catch (error) {
      logger.error('Collection pass failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      if (failures.fail(Date.now())) {
        await notifyAttention(
          config.notify,
          SERVICE,
          `Cannot read WeChat's databases: ${
            error instanceof Error ? error.message : String(error)
          }. Is WeChat running and logged in, and is the key still valid?`,
        )
      }
    }
    await sleep(config.pollSeconds * 1000)
  }

  await pool.end()
  logger.info('Collector stopped')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
  })
}

main().catch((error) => {
  logger.error('Fatal', { error })
  process.exitCode = 1
})
