import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { TweetQueue } from './tweet-queue.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const queue = new TweetQueue(pool)

beforeEach(async () => {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
})

afterAll(async () => {
  await pool.query("DELETE FROM tweets WHERE dedupe_key LIKE 'test:%'")
  await pool.end()
})

describe('enqueue', () => {
  it('stores a pending tweet', async () => {
    const tweet = await queue.enqueue({
      content: 'hello world',
      dedupeKey: 'test:1',
    })
    expect(tweet).not.toBeNull()
    expect(tweet!.content).toBe('hello world')
    expect(tweet!.status).toBe('pending')
    expect(tweet!.attempts).toBe(0)
    expect(tweet!.postedAt).toBeNull()
  })

  it('returns null rather than throwing on a duplicate dedupe key', async () => {
    await queue.enqueue({ content: 'first', dedupeKey: 'test:dup' })
    const second = await queue.enqueue({
      content: 'second',
      dedupeKey: 'test:dup',
    })
    expect(second).toBeNull()
  })

  it('records source attribution', async () => {
    const tweet = await queue.enqueue({
      content: 'sourced',
      dedupeKey: 'test:src',
      source: 'ai-assistant',
      sourceRef: '123456789',
    })
    expect(tweet!.source).toBe('ai-assistant')
    expect(tweet!.sourceRef).toBe('123456789')
  })

  it('round-trips the media path and archetype', async () => {
    const tweet = await queue.enqueue({
      content: 'hello',
      // The `test:` prefix matters — the cleanup at the top of this file
      // deletes by `dedupe_key LIKE 'test:%'`, and a row outside that prefix
      // survives the suite and pollutes the queue.
      dedupeKey: 'test:media',
      source: 'lab_article',
      sourceRef: 'abc',
      mediaPath: './media/abc.png',
      archetype: 'digest',
    })

    expect(tweet).not.toBeNull()
    expect(tweet!.mediaPath).toBe('./media/abc.png')
    expect(tweet!.archetype).toBe('digest')
  })

  it('leaves both null when they are not supplied', async () => {
    const tweet = await queue.enqueue({
      content: 'hello',
      dedupeKey: 'test:no-media',
    })

    expect(tweet!.mediaPath).toBeNull()
    expect(tweet!.archetype).toBeNull()
  })
})

describe('claimNext', () => {
  it('claims the oldest due tweet and marks it sending', async () => {
    await queue.enqueue({ content: 'older', dedupeKey: 'test:a' })
    await queue.enqueue({ content: 'newer', dedupeKey: 'test:b' })

    const claimed = await queue.claimNext()
    expect(claimed!.content).toBe('older')
    expect(claimed!.status).toBe('sending')
    expect(claimed!.attempts).toBe(1)
  })

  it('does not claim the same row twice', async () => {
    await queue.enqueue({ content: 'only one', dedupeKey: 'test:one' })
    const first = await queue.claimNext()
    const second = await queue.claimNext()
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('skips tweets scheduled for the future', async () => {
    await queue.enqueue({
      content: 'later',
      dedupeKey: 'test:later',
      scheduledAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    expect(await queue.claimNext()).toBeNull()
  })

  it('returns null on an empty queue', async () => {
    expect(await queue.claimNext()).toBeNull()
  })
})

describe('terminal transitions', () => {
  it('marks a tweet posted with its url', async () => {
    await queue.enqueue({ content: 'ok', dedupeKey: 'test:ok' })
    const claimed = await queue.claimNext()
    await queue.markPosted(claimed!.id, 'https://x.com/someone/status/1')

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('posted')
    expect(stored!.postedUrl).toBe('https://x.com/someone/status/1')
    expect(stored!.postedAt).toBeInstanceOf(Date)
  })

  it('marks a tweet failed with its error', async () => {
    await queue.enqueue({ content: 'bad', dedupeKey: 'test:bad' })
    const claimed = await queue.claimNext()
    await queue.markFailed(claimed!.id, 'gave up after 3 attempts')

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('failed')
    expect(stored!.lastError).toBe('gave up after 3 attempts')
    expect(stored!.postedAt).toBeNull()
  })

  it('marks a tweet uncertain and leaves it unclaimable', async () => {
    // Uncertain rows must never be picked up again: the tweet may be live.
    await queue.enqueue({ content: 'maybe sent', dedupeKey: 'test:maybe' })
    const claimed = await queue.claimNext()
    await queue.markUncertain(claimed!.id, 'clicked but could not verify')

    expect((await queue.getById(claimed!.id))!.status).toBe('uncertain')
    expect(await queue.claimNext()).toBeNull()
  })
})

describe('releaseForRetry', () => {
  it('returns the tweet to pending with a future schedule', async () => {
    await queue.enqueue({ content: 'retry me', dedupeKey: 'test:retry' })
    const claimed = await queue.claimNext()
    const retryAt = new Date(Date.now() + 60 * 60 * 1000)
    await queue.releaseForRetry(claimed!.id, 'network hiccup', retryAt)

    const stored = await queue.getById(claimed!.id)
    expect(stored!.status).toBe('pending')
    expect(stored!.lastError).toBe('network hiccup')
    expect(stored!.attempts).toBe(1)
    expect(await queue.claimNext()).toBeNull()
  })

  it('keeps incrementing attempts across claims', async () => {
    await queue.enqueue({ content: 'flaky', dedupeKey: 'test:flaky' })
    const first = await queue.claimNext()
    await queue.releaseForRetry(first!.id, 'once', new Date(Date.now() - 1000))
    const second = await queue.claimNext()
    expect(second!.attempts).toBe(2)
  })
})

/**
 * history() reports on the whole table by design — that is what the rate
 * limiter needs. So these assert deltas against a baseline rather than
 * absolute counts: the alternative would be truncating a table that holds
 * the operator's real queue.
 */
describe('history', () => {
  /** The zone the deployment counts its day in; see x-poster's TIMEZONE. */
  const TZ = 'Asia/Shanghai'

  it('does not count a tweet that was never posted', async () => {
    const before = await queue.history(TZ)
    await queue.enqueue({ content: 'unposted', dedupeKey: 'test:h0' })
    expect((await queue.history(TZ)).postedToday).toBe(before.postedToday)
  })

  it('counts today posts and reports the most recent', async () => {
    const before = await queue.history(TZ)

    await queue.enqueue({ content: 'one', dedupeKey: 'test:h1' })
    await queue.enqueue({ content: 'two', dedupeKey: 'test:h2' })

    const first = await queue.claimNext()
    await queue.markPosted(first!.id, null)
    const second = await queue.claimNext()
    await queue.markPosted(second!.id, null)

    const after = await queue.history(TZ)
    expect(after.postedToday).toBe(before.postedToday + 2)
    expect(after.lastPostedAt).toBeInstanceOf(Date)
  })

  it('does not count failed or uncertain tweets as posted', async () => {
    const before = await queue.history(TZ)

    await queue.enqueue({ content: 'nope', dedupeKey: 'test:h3' })
    const failed = await queue.claimNext()
    await queue.markFailed(failed!.id, 'nope')

    await queue.enqueue({ content: 'maybe', dedupeKey: 'test:h4' })
    const unsure = await queue.claimNext()
    await queue.markUncertain(unsure!.id, 'unverified')

    expect((await queue.history(TZ)).postedToday).toBe(before.postedToday)
  })

  it('counts only what was posted since the given instant', async () => {
    // What a window needs: a morning window's four must not be charged
    // against the evening's six, so the boundary matters and the day's total
    // does not.
    //
    // The boundaries are an hour out either side because `markPosted` writes
    // the database's `now()` and the assertions run on the host's clock; an
    // hour of slack means the case does not depend on the two agreeing.
    const anHourAgo = new Date(Date.now() - 60 * 60_000)
    const inAnHour = new Date(Date.now() + 60 * 60_000)
    const before = await queue.postedSince(anHourAgo)

    // Posted straight from the enqueued rows rather than through `claimNext`.
    // What is under test is the counting, and claiming brings in the
    // `scheduled_at <= now` race that makes the rest of this file flaky.
    const one = await queue.enqueue({ content: 'one', dedupeKey: 'test:w1' })
    const two = await queue.enqueue({ content: 'two', dedupeKey: 'test:w2' })
    await queue.markPosted(one!.id, null)
    await queue.markPosted(two!.id, null)

    expect(await queue.postedSince(anHourAgo)).toBe(before + 2)
    expect(await queue.postedSince(inAnHour)).toBe(0)
  })
})
