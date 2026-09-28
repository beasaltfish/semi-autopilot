import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { GeneratorStore } from './store.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new GeneratorStore(pool)

async function clean(): Promise<void> {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
  await pool.query(
    "DELETE FROM generation_attempts WHERE external_id LIKE 'test:%'",
  )
}

/** Simulates x-poster having posted a row, which this service never does. */
async function markPosted(dedupeKey: string): Promise<void> {
  await pool.query(
    `UPDATE tweets SET status = 'posted', posted_at = NOW()
     WHERE dedupe_key = $1`,
    [dedupeKey],
  )
}

beforeEach(clean)

afterAll(async () => {
  await clean()
  await pool.end()
})

/** Rows the usage query must see have to be inside the day it is given. */
const dayStart = new Date(Date.now() - 60 * 60 * 1000)

describe('enqueue', () => {
  it('returns the new row id', async () => {
    const id = await store.enqueue({
      content: 'hello',
      dedupeKey: 'test:e1',
      source: 'lab_article',
      sourceRef: 'abc',
      archetype: 'digest',
      mediaPath: './media/abc.png',
    })
    expect(id).not.toBeNull()
  })

  it('returns null rather than throwing on a duplicate key', async () => {
    // The UNIQUE constraint is the whole deduplication mechanism for blogs,
    // so losing this race must be ordinary control flow, not an exception.
    await store.enqueue({ content: 'a', dedupeKey: 'test:e2' })
    expect(await store.enqueue({ content: 'b', dedupeKey: 'test:e2' })).toBeNull()
  })

  it('writes a row x-poster can claim', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:e3' })
    const row = await pool.query(
      `SELECT status, attempts, scheduled_at FROM tweets WHERE dedupe_key = 'test:e3'`,
    )
    expect(row.rows[0].status).toBe('pending')
    expect(row.rows[0].attempts).toBe(0)
    expect(row.rows[0].scheduled_at).toBeInstanceOf(Date)
  })
})

describe('usageSince', () => {
  it('counts nothing on an empty day', async () => {
    const usage = await store.usageSince(new Date(Date.now() + 60_000))
    expect(usage.total).toBe(0)
    expect(usage.used.labs).toBe(0)
  })

  // usageSince counts the whole day by design, so these assert deltas. An
  // absolute count would pass only while the table happens to hold nothing
  // but test rows, and fail forever after the first real tweet is queued.
  it('counts rows per tier and in total', async () => {
    const before = await store.usageSince(dayStart)

    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u1',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:u2',
      source: 'lab_article',
    })
    await store.enqueue({
      content: 'c',
      dedupeKey: 'test:u3',
      source: 'hn_story',
    })

    const after = await store.usageSince(dayStart)
    expect(after.used.labs - before.used.labs).toBe(2)
    expect(after.used.hot - before.used.hot).toBe(1)
    expect(after.used.project - before.used.project).toBe(0)
    expect(after.total - before.total).toBe(3)
  })

  it('counts every row regardless of status', async () => {
    // Quota is spent when the generator commits to a slot, not when x-poster
    // succeeds. Counting only 'posted' would let a failed tweet be silently
    // replaced, quietly exceeding the daily cap.
    const before = await store.usageSince(dayStart)

    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:u4',
      source: 'lab_article',
    })
    await pool.query(
      `UPDATE tweets SET status = 'failed' WHERE dedupe_key = 'test:u4'`,
    )

    const after = await store.usageSince(dayStart)
    expect(after.used.labs - before.used.labs).toBe(1)
  })
})

describe('knownDedupeKeys', () => {
  it('returns only the keys that already exist', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:k1' })

    const known = await store.knownDedupeKeys(['test:k1', 'test:k2'])
    expect(known.has('test:k1')).toBe(true)
    expect(known.has('test:k2')).toBe(false)
  })

  it('handles an empty list without issuing a query', async () => {
    expect((await store.knownDedupeKeys([])).size).toBe(0)
  })
})

/**
 * `lastArchetype` and `lastEnqueuedAt` read the whole table by design — the
 * rules they back are about the account's timeline, not about test rows. So
 * neither is asserted against an empty table: that assertion would pass only
 * until the first real row lands and then fail forever. Their cold-start
 * paths are a plain `?? null`; what is worth testing is the ordering.
 */
describe('lastArchetype', () => {
  it('returns the most recently created archetype', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:a1',
      archetype: 'digest',
    })
    await store.enqueue({
      content: 'b',
      dedupeKey: 'test:a2',
      archetype: 'take',
    })

    expect(await store.lastArchetype()).toBe('take')
  })
})

describe('lastEnqueuedAt', () => {
  it('returns a recent timestamp after an enqueue', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:t1' })
    const at = await store.lastEnqueuedAt()
    expect(at).not.toBeNull()
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000)
  })
})

describe('failureCounts and recordFailure', () => {
  it('starts at zero and increments', async () => {
    expect(
      (await store.failureCounts(['test:c1'])).get('test:c1'),
    ).toBeUndefined()

    await store.recordFailure('test:c1', 'validator gave up')
    await store.recordFailure('test:c1', 'validator gave up again')

    expect((await store.failureCounts(['test:c1'])).get('test:c1')).toBe(2)
  })

  it('handles an empty list', async () => {
    expect((await store.failureCounts([])).size).toBe(0)
  })
})

describe('expiredMedia', () => {
  it('returns paths for tweets posted before the cutoff', async () => {
    await store.enqueue({
      content: 'a',
      dedupeKey: 'test:m1',
      mediaPath: './media/old.png',
    })
    await markPosted('test:m1')

    expect(await store.expiredMedia(new Date(Date.now() + 60_000))).toContain(
      './media/old.png',
    )
    expect(await store.expiredMedia(dayStart)).not.toContain('./media/old.png')
  })
})

/** Puts a row into one of the states only x-poster ever writes. */
async function setStatus(dedupeKey: string, status: string): Promise<void> {
  await pool.query('UPDATE tweets SET status = $2 WHERE dedupe_key = $1', [
    dedupeKey,
    status,
  ])
}

/**
 * Asserted as a delta, not an absolute.
 *
 * `pendingCount` is deliberately unbounded — the buffer is the whole table, so
 * there is no day or key prefix to scope it to. `clean` only removes this
 * suite's rows, so a real tweet left queued by a live run would otherwise make
 * these fail for a reason that has nothing to do with the code under test.
 */
describe('pendingCount', () => {
  let baseline = 0

  beforeEach(async () => {
    baseline = await store.pendingCount()
  })

  it('counts the rows still waiting to be posted', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p1' })
    await store.enqueue({ content: 'b', dedupeKey: 'test:p2' })

    expect(await store.pendingCount()).toBe(baseline + 2)
  })

  it('stops counting a row once x-poster has posted it', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p3' })
    await markPosted('test:p3')

    expect(await store.pendingCount()).toBe(baseline)
  })

  it('does not count a row x-poster has already claimed', async () => {
    // 'sending' is stock that has left the shelf. Counting it would let the
    // buffer read as full while the item is already on its way out.
    await store.enqueue({ content: 'a', dedupeKey: 'test:p4' })
    await setStatus('test:p4', 'sending')

    expect(await store.pendingCount()).toBe(baseline)
  })

  it('does not count rows in a terminal state', async () => {
    await store.enqueue({ content: 'a', dedupeKey: 'test:p5' })
    await store.enqueue({ content: 'b', dedupeKey: 'test:p6' })
    await setStatus('test:p5', 'failed')
    await setStatus('test:p6', 'uncertain')

    expect(await store.pendingCount()).toBe(baseline)
  })
})
