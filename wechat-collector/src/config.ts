import 'dotenv/config'
import type { LlmConfig } from 'shared/llm'
import { loadNotifyTarget, type NotifyTarget } from 'shared/notifier'

export interface CollectorConfig {
  dbDir: string
  keysPath: string
  groups: string[]
  pollSeconds: number
  overlapSeconds: number
  backfillDays: number
  /** Null when no embedding model is named: collect, but do not embed. */
  embedding: (LlmConfig & { minChars: number }) | null
  notify: NotifyTarget | null
}

function requiredString(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`${key} is required`)
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer, got: ${raw}`)
  }
  return value
}

function parseGroups(raw: string | undefined): string[] {
  if (!raw) return []
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  for (const id of ids) {
    if (!id.endsWith('@chatroom')) {
      throw new Error(
        `WECHAT_GROUPS takes group ids ending in @chatroom, got: ${id}. ` +
          'List them with `pnpm --filter wechat-collector groups`.',
      )
    }
  }
  return [...new Set(ids)]
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): CollectorConfig {
  const dbDir = requiredString(env, 'WECHAT_DB_DIR')
  const keysPath = requiredString(env, 'WECHAT_KEYS_PATH')
  const embeddingModel = env.EMBEDDING_MODEL || null

  return {
    dbDir,
    keysPath,
    groups: parseGroups(env.WECHAT_GROUPS),
    pollSeconds: positiveInt(env, 'WECHAT_POLL_SECONDS', 10),
    overlapSeconds: positiveInt(env, 'WECHAT_OVERLAP_SECONDS', 300),
    backfillDays: positiveInt(env, 'WECHAT_BACKFILL_DAYS', 30),
    embedding: embeddingModel
      ? {
          baseUrl: env.LLM_BASE_URL || 'http://localhost:20128/v1',
          apiKey: env.LLM_API_KEY || null,
          // LlmConfig insists on a chat model; this service only embeds, so
          // the embedding model stands in rather than inventing one.
          model: embeddingModel,
          embeddingModel,
          timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 120_000),
          minChars: positiveInt(env, 'WECHAT_EMBED_MIN_CHARS', 4),
        }
      : null,
    notify: loadNotifyTarget(env),
  }
}
