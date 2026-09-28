import { describe, expect, it } from 'vitest'
import { createDb, createPool, loadDbConfig } from './db.js'
import { tweets } from './schema.js'

describe('loadDbConfig', () => {
  it('reads every field from the environment', () => {
    expect(
      loadDbConfig({
        DB_USER: 'someone',
        DB_HOST: 'db.example.com',
        DB_NAME: 'somedb',
        DB_PASSWORD: 'secret',
        DB_PORT: '6543',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      user: 'someone',
      host: 'db.example.com',
      database: 'somedb',
      password: 'secret',
      port: 6543,
    })
  })

  it('applies the same defaults the services used before', () => {
    expect(loadDbConfig({} as NodeJS.ProcessEnv)).toEqual({
      user: 'app_user',
      host: 'localhost',
      database: 'semi_autopilot',
      password: '',
      port: 5432,
    })
  })

  it('rejects a port that is not a number', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: 'not-a-port' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })

  it('rejects a port outside the valid range', () => {
    expect(() =>
      loadDbConfig({ DB_PORT: '70000' } as NodeJS.ProcessEnv),
    ).toThrow(/DB_PORT/)
  })
})

describe('createPool', () => {
  it('applies the pool tuning both services had settled on', () => {
    const pool = createPool({
      user: 'u',
      host: 'h',
      database: 'd',
      password: 'p',
      port: 5432,
    })
    expect(pool.options.max).toBe(10)
    expect(pool.options.idleTimeoutMillis).toBe(30_000)
  })

  it('lets a caller override the tuning', () => {
    const pool = createPool(
      { user: 'u', host: 'h', database: 'd', password: 'p', port: 5432 },
      { max: 3 },
    )
    expect(pool.options.max).toBe(3)
  })

  it('builds a pool from the given config', async () => {
    const pool = createPool({
      user: 'app_user',
      host: 'localhost',
      database: 'semi_autopilot',
      password: 'defaultpassword123',
      port: 5432,
    })
    try {
      const result = await pool.query('SELECT 1 AS one')
      expect(result.rows[0]).toEqual({ one: 1 })
    } finally {
      await pool.end()
    }
  })
})

describe('createDb', () => {
  it('runs a Drizzle query against the real database', async () => {
    const pool = createPool({
      user: 'app_user',
      host: 'localhost',
      database: 'semi_autopilot',
      password: 'defaultpassword123',
      port: 5432,
    })
    try {
      const db = createDb(pool)
      // The point is not the rows: it is that a Drizzle query compiles to SQL
      // Postgres accepts, and comes back shaped by the schema rather than by
      // the column names.
      const rows = await db.select().from(tweets).limit(0)
      expect(rows).toEqual([])
    } finally {
      await pool.end()
    }
  })
})
