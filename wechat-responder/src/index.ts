/**
 * The responder service. Two things run on the poll:
 *   - judge newly collected WeChat messages, store one decision each, and —
 *     within the per-group hourly rate limit — push a card, and
 *   - drain the owner's Telegram callbacks (👍/👎/✏️/知道了) into feedback,
 *     and mark stale cards expired.
 *
 * Shadow mode: nothing is sent to WeChat. A decision is stored before its card
 * is pushed, so a restart never re-pushes one (a decision with a
 * telegram_message_id is done). On Jev/LLM trouble a message is left unjudged
 * to retry, and the owner is alerted once.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPool } from 'shared/db'
import { JevClient } from 'shared/jev'
import { LlmClient } from 'shared/llm'
import { createLogger } from 'shared/logger'
import { notifyAttention } from 'shared/notifier'
import { mulberry32 } from 'shared/rng'
import { loadConfig } from './config.js'
import { judge } from './pipeline.js'
import { Retrieval } from './retrieval.js'
import { ResponderStore } from './store.js'
import { alertCard, draftCard, parseCallback } from './telegram/card.js'
import { TelegramBot } from './telegram/bot.js'

const SERVICE = 'wechat-responder'
const CLAIM_BATCH = 50
const CONTEXT_SIZE = 6
const EXPERT_NEIGHBOURS = 8
const MAX_DRAFT_CHARS = 200

const here = fileURLToPath(import.meta.url)
function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as T
}

const logger = createLogger('wechat-responder.log')
const config = loadConfig()
const pool = createPool(config.db)
const store = new ResponderStore(pool)
const retrieval = new Retrieval(pool)
const jev = new JevClient(config.jev)
const llm = new LlmClient(config.llm)
const bot = new TelegramBot(config.telegram)

const templates = loadJson<string[]>('templates.json')
const banned = loadJson<string[]>('banned-phrases.json')
const styleRules = loadJson<string[]>('style-rules.json')

let stopping = false
let updateOffset = 0
/** The decision awaiting an edited draft, set when the owner presses ✏️. */
let pendingEdit: number | null = null
let alerted = false

async function sleep(ms: number): Promise<void> {
  const step = 500
  let elapsed = 0
  while (elapsed < ms && !stopping) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - elapsed)))
    elapsed += step
  }
}

/** Push the card for a stored decision, unless the group's hourly cap is hit. */
async function pushCard(
  decisionId: number,
  candidate: { channelId: string; authorName: string; content: string },
  decision: Awaited<ReturnType<typeof judge>>,
): Promise<void> {
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  if (decision.route !== 'alert') {
    const sent = await store.draftsInGroupSince(candidate.channelId, hourAgo)
    if (sent >= config.draftsPerGroupPerHour) {
      logger.info('Rate limit reached; card withheld', { channelId: candidate.channelId })
      return
    }
  }
  const jevMap = decision.jev ?? {}
  const card =
    decision.route === 'alert'
      ? alertCard({
          decisionId,
          group: candidate.channelId,
          sender: candidate.authorName,
          message: candidate.content,
          reason: jevMap.intent?.label === 'critical' ? 'critical' : 'ai_probe',
          jev: jevMap,
        })
      : draftCard({
          decisionId,
          group: candidate.channelId,
          sender: candidate.authorName,
          message: candidate.content,
          jev: jevMap,
          mentionName: null,
          draft: decision.draft ?? null,
        })
  const telegramMessageId = await bot.send(card)
  await store.attachTelegramId(decisionId, telegramMessageId)
}

async function judgePass(): Promise<void> {
  const candidates = await store.claimUnjudged(CLAIM_BATCH)
  for (const candidate of candidates) {
    if (stopping) break
    const decision = await judge(
      candidate,
      {
        jev,
        llm,
        retrieval,
        embed: async (text) => (await llm.embed([text]))[0],
        recentContext: (channelId, before, n) => store.recentContext(channelId, before, n),
        templatesUsedFor: (authorId, since) => store.templatesUsedFor(authorId, since),
        rng: mulberry32(candidate.id),
      },
      {
        owner: { id: config.ownerId, names: config.ownerNames },
        thresholds: config.thresholds,
        templates,
        styleRules,
        banned,
        maxDraftChars: MAX_DRAFT_CHARS,
        templateCooldownMinutes: config.templateCooldownMinutes,
        contextSize: CONTEXT_SIZE,
        expertNeighbours: EXPERT_NEIGHBOURS,
        now: new Date(),
      },
    )

    const decisionId = await store.recordDecision(decision)
    if (decision.route === 'alert' || decision.route === 'draft' || decision.route === 'template') {
      await pushCard(decisionId, candidate, decision)
    }
  }
  alerted = false
}

async function telegramPass(): Promise<void> {
  const { nextOffset, events } = await bot.poll(updateOffset)
  updateOffset = nextOffset
  for (const event of events) {
    if (event.kind === 'callback' && event.data && event.messageId !== undefined) {
      const callback = parseCallback(event.data)
      if (!callback) continue
      if (callback.action === 'edit') {
        pendingEdit = event.messageId
      } else {
        const feedback =
          callback.action === 'approve' ? 'approve' : callback.action === 'reject' ? 'reject' : 'ack'
        await store.recordFeedback(event.messageId, feedback)
        pendingEdit = null
      }
      if (event.callbackId) await bot.answerCallback(event.callbackId)
    } else if (event.kind === 'text' && pendingEdit !== null && event.text) {
      // The text after a ✏️ press is the owner's edited draft.
      await store.recordFeedback(pendingEdit, 'edit', event.text)
      pendingEdit = null
    }
  }
}

async function expiryPass(): Promise<void> {
  const cutoff = new Date(Date.now() - config.cardExpiryMinutes * 60_000)
  for (const { telegramMessageId } of await store.expireStale(cutoff)) {
    await bot.editExpired(telegramMessageId, '⌛️ 这条已过期（未处理）')
  }
}

async function tick(): Promise<void> {
  await judgePass()
  await telegramPass()
  await expiryPass()
}

async function main(): Promise<void> {
  logger.info('Responder started (shadow mode)', {
    groups: config.ownerNames.length,
    pollSeconds: config.pollSeconds,
  })
  while (!stopping) {
    try {
      await tick()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('Responder pass failed', { error: message })
      if (!alerted) {
        alerted = true
        await notifyAttention(config.notify, SERVICE, `A responder pass failed: ${message}`)
      }
    }
    await sleep(config.pollSeconds * 1000)
  }
  await pool.end()
  logger.info('Responder stopped')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
  })
}

if (process.argv[1] === here) {
  main().catch((error) => {
    logger.error('Fatal', { error })
    process.exitCode = 1
  })
}
