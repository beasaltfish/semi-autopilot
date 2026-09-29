import 'dotenv/config'
import { type DbConfig, loadDbConfig } from 'shared/db'
import type { JevConfig } from 'shared/jev'
import type { LlmConfig } from 'shared/llm'
import { loadNotifyTarget, type NotifyTarget } from 'shared/notifier'

export interface Thresholds {
  /** Below this intent confidence, a message is not drafted on. */
  intentMin: number
  /** Praise needs at least this confidence to earn a template reply. */
  praiseMin: number
  /** Jev's "addressed to the owner" needs this to count as addressed. */
  addressedMin: number
}

export interface ResponderConfig {
  db: DbConfig
  jev: JevConfig
  llm: LlmConfig
  /** The owner's own wxid: their messages are never drafted to. */
  ownerId: string
  /** Names the owner is called by in the groups, for the "names owner" rule. */
  ownerNames: string[]
  telegram: { botToken: string; chatId: string }
  /** System notifications (Jev/LLM down). Separate from the owner's cards. */
  notify: NotifyTarget | null
  thresholds: Thresholds
  draftsPerGroupPerHour: number
  templateCooldownMinutes: number
  cardExpiryMinutes: number
  pollSeconds: number
}

function requiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`)
  }
  return value
}

/** A probability in [0, 1]. */
function fraction(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be between 0 and 1, got: ${raw}`)
  }
  return value
}

function parseList(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Jev via OpenRouter's decisions endpoint, billed to the OpenRouter account. */
export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  return {
    url: env.JEV_URL || 'https://openrouter.ai/api/alpha/decisions',
    apiKey: requiredString(env, 'OPENROUTER_API_KEY'),
    model: env.JEV_MODEL || 'typesafe/jev-1.13',
    timeoutMs: positiveInt(env, 'JEV_TIMEOUT_MS', 30_000),
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResponderConfig {
  return {
    db: loadDbConfig(env),
    jev: loadJevConfig(env),
    llm: {
      baseUrl: env.LLM_BASE_URL || 'http://localhost:20128/v1',
      apiKey: env.LLM_API_KEY || null,
      // The draft model. Required and singular — no "auto".
      model: requiredString(env, 'LLM_MODEL'),
      timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 120_000),
    },
    ownerId: requiredString(env, 'WECHAT_OWNER_ID'),
    ownerNames: parseList(env.WECHAT_OWNER_NAMES),
    telegram: {
      botToken: requiredString(env, 'TELEGRAM_BOT_TOKEN'),
      chatId: requiredString(env, 'TELEGRAM_CHAT_ID'),
    },
    notify: loadNotifyTarget(env),
    thresholds: {
      intentMin: fraction(env, 'INTENT_MIN', 0.6),
      praiseMin: fraction(env, 'PRAISE_MIN', 0.7),
      addressedMin: fraction(env, 'ADDRESSED_MIN', 0.6),
    },
    draftsPerGroupPerHour: positiveInt(env, 'DRAFTS_PER_GROUP_PER_HOUR', 4),
    templateCooldownMinutes: positiveInt(env, 'TEMPLATE_COOLDOWN_MINUTES', 180),
    cardExpiryMinutes: positiveInt(env, 'CARD_EXPIRY_MINUTES', 30),
    pollSeconds: positiveInt(env, 'RESPONDER_POLL_SECONDS', 15),
  }
}
