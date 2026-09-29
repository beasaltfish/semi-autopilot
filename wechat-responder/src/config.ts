import 'dotenv/config'
import type { JevConfig } from 'shared/jev'

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

/** Jev via OpenRouter's decisions endpoint, billed to the OpenRouter account. */
export function loadJevConfig(env: NodeJS.ProcessEnv = process.env): JevConfig {
  return {
    url: env.JEV_URL || 'https://openrouter.ai/api/alpha/decisions',
    apiKey: requiredString(env, 'OPENROUTER_API_KEY'),
    model: env.JEV_MODEL || 'typesafe/jev-1.13',
    timeoutMs: positiveInt(env, 'JEV_TIMEOUT_MS', 30_000),
  }
}
