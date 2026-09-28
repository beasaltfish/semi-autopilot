import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool, type PoolConfig } from 'pg'
import * as schema from './schema.js'

/** The Postgres connection shape every service in this workspace uses. */
export interface DbConfig {
  user: string
  host: string
  database: string
  password: string
  port: number
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 5432
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `DB_PORT must be an integer between 1 and 65535, got: ${raw}`,
    )
  }
  return port
}

export function loadDbConfig(env: NodeJS.ProcessEnv = process.env): DbConfig {
  return {
    // Matches the user docker-compose.yml creates. The previous default of
    // 'postgres' is a role that does not exist in that container, so omitting
    // DB_USER failed with a confusing "role does not exist" rather than
    // working out of the box.
    user: env.DB_USER ?? 'app_user',
    host: env.DB_HOST ?? 'localhost',
    database: env.DB_NAME ?? 'semi_autopilot',
    password: env.DB_PASSWORD ?? '',
    port: parsePort(env.DB_PORT),
  }
}

/**
 * Pool tuning both services had arrived at independently, so it belongs here
 * rather than being restated at each call site.
 */
const POOL_DEFAULTS = {
  max: 10,
  idleTimeoutMillis: 30_000,
} satisfies PoolConfig

export function createPool(
  config: DbConfig = loadDbConfig(),
  overrides: PoolConfig = {},
): Pool {
  return new Pool({ ...POOL_DEFAULTS, ...config, ...overrides })
}

/**
 * The Drizzle handle, bound to a pool the caller already owns.
 *
 * Drizzle does not replace `pg` here — it wraps the same pool, so connection
 * limits, timeouts and shutdown stay in one place. Passing the schema is what
 * makes query results come back keyed by the schema's field names instead of
 * the database's column names, which is the whole reason the hand-written row
 * mappers can go away.
 */
export function createDb(pool: Pool): NodePgDatabase<typeof schema> {
  return drizzle({ client: pool, schema })
}
