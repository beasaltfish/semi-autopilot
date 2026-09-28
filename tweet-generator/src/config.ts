import dotenv from 'dotenv'
import { loadDbConfig, type DbConfig } from 'shared/db'
import type { LlmConfig } from 'shared/llm'

dotenv.config()

/** The four AgentLens dispatch kinds this service draws from. */
export type SourceKind =
  | 'lab_article'
  | 'gh_project'
  | 'x_digest'
  | 'hn_story'

/**
 * What a post is for, which is a different question from where it came from.
 *
 * Quota lives here rather than on the kind because `hn_story` and `x_digest`
 * do the same job — they are what is being talked about right now — while
 * differing entirely in whether the API can tell us how loudly.
 */
export type Tier = 'project' | 'hot' | 'labs'

export const TIER_OF_KIND: Record<SourceKind, Tier> = {
  gh_project: 'project',
  hn_story: 'hot',
  x_digest: 'hot',
  lab_article: 'labs',
}

/** Breaks ties in the quota picker when two tiers have equal headroom. */
export const TIER_PRIORITY: readonly Tier[] = ['hot', 'project', 'labs']

export const KINDS_OF_TIER: Record<Tier, readonly SourceKind[]> = {
  project: ['gh_project'],
  hot: ['x_digest', 'hn_story'],
  labs: ['lab_article'],
}

export type Quota = Record<Tier, number>

export interface GeneratorConfig {
  db: DbConfig
  agentlensBaseUrl: string
  llm: LlmConfig
  queueTarget: number
  queuePollMinutes: number
  emptyPoolMinutes: number
  dailyCap: number
  quota: Quota
  /**
   * How much of the ranking is entity salience versus raw discussion volume.
   * Above 0.5 on purpose: a story can be the loudest thing on HN and still
   * be about a pen plotter.
   */
  entityWeight: number
  /** Only the comparison finder needs it, and only from phase two. */
  agentlensApiKey: string | null
  projectMinVelocityPerDay: number
  timezone: string
  maxRounds: number
  bannedPhrasesFile: string
  mediaDir: string
  mediaRetentionDays: number
  discordWebhookUrl: string | null
}

function nonNegativeInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer, got: ${raw}`)
  }
  return value
}

function positiveInt(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const value = nonNegativeInt(env, key, fallback)
  if (value < 1) throw new Error(`${key} must be a positive integer`)
  return value
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): GeneratorConfig {
  const model = env.LLM_MODEL
  if (!model) {
    throw new Error(
      'LLM_MODEL is required. OmniRoute falls back across provider tiers, ' +
        'so an unpinned model means a different writer every day.',
    )
  }
  if (model.toLowerCase() === 'auto') {
    throw new Error(
      'LLM_MODEL must be pinned to a specific model, not "auto". Unattended ' +
        "posts inherit the router's quality floor as the account's.",
    )
  }

  const quota: Quota = {
    hot: nonNegativeInt(env, 'QUOTA_HOT', 5),
    project: nonNegativeInt(env, 'QUOTA_PROJECT', 3),
    labs: nonNegativeInt(env, 'QUOTA_LABS', 2),
  }

  const dailyCap = positiveInt(env, 'DAILY_CAP', 10)
  const quotaTotal = Object.values(quota).reduce((sum, n) => sum + n, 0)
  if (quotaTotal > dailyCap) {
    // Quota that cannot be spent is quota that silently never fires, which
    // reads as "the lowest-priority source is broken" rather than as a
    // configuration mistake.
    throw new Error(
      `The quota total (${quotaTotal}) exceeds DAILY_CAP (${dailyCap})`,
    )
  }


  return {
    db: loadDbConfig(env),
    agentlensBaseUrl: env.AGENTLENS_BASE_URL || 'https://api.agentlenshq.com',
    llm: {
      baseUrl: env.LLM_BASE_URL || 'http://localhost:20128/v1',
      apiKey: env.LLM_API_KEY || null,
      model,
      timeoutMs: positiveInt(env, 'LLM_TIMEOUT_MS', 120_000),
    },
    // How much stock to hold, not how often to produce. x-poster sets the
    // pace; this only has to cover the gap between one being taken and the
    // next being written.
    queueTarget: positiveInt(env, 'QUEUE_TARGET', 2),
    // The full-buffer check is a bare COUNT, so it can afford to be frequent.
    queuePollMinutes: positiveInt(env, 'QUEUE_POLL_MINUTES', 5),
    // A cycle that produced nothing spent an AgentLens call to find out, so
    // this one cannot be.
    emptyPoolMinutes: positiveInt(env, 'EMPTY_POOL_MINUTES', 30),
    dailyCap,
    quota,
    entityWeight: Number(env.ENTITY_WEIGHT ?? '0.7'),
    agentlensApiKey: env.AGENTLENS_API_KEY || null,
    projectMinVelocityPerDay: nonNegativeInt(
      env,
      'PROJECT_MIN_VELOCITY_PER_DAY',
      20,
    ),
    timezone: env.TIMEZONE || 'Asia/Shanghai',
    maxRounds: positiveInt(env, 'MAX_ROUNDS', 3),
    bannedPhrasesFile: env.BANNED_PHRASES_FILE || './banned-phrases.json',
    mediaDir: env.MEDIA_DIR || './media',
    mediaRetentionDays: nonNegativeInt(env, 'MEDIA_RETENTION_DAYS', 7),
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL || null,
  }
}
