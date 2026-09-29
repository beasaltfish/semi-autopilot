import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { collectGroup, collectOnce, resumeSecond } from './collect.js'
import { MessageDbWriter, randomRawKey } from './fixture.js'
import { openShards } from './shards.js'
import { CollectorStore } from './store.js'

const options = { overlapSeconds: 300, backfillDays: 30 }

describe('resumeSecond', () => {
  it('goes backfillDays back when nothing is stored', () => {
    const now = new Date('2026-09-30T00:00:00Z')
    const since = resumeSecond(null, now, options)
    expect(since).toBe(Math.floor(now.getTime() / 1000) - 30 * 86_400)
  })

  it('steps back by the overlap from the newest stored message', () => {
    const newest = new Date('2026-09-30T00:00:00Z')
    const since = resumeSecond(newest, new Date(), options)
    expect(since).toBe(Math.floor(newest.getTime() / 1000) - 300)
  })
})

// The store side needs Postgres, like the other store-backed tests.
const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new CollectorStore(pool)
const PREFIX = 'test-collectpass-'
const GROUP = `${PREFIX}g@chatroom`
// A high id range disjoint from store.test's, since (source, message_id) is
// globally unique and the two DB test files run in parallel.
const BASE = 9_000_000_000_000_000_000n
const ALICE = 'wxid_alice'

let dir: string
beforeEach(async () => {
  await pool.query(
    "DELETE FROM messages WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
  dir = mkdtempSync(join(tmpdir(), 'wechat-collect-'))
  mkdirSync(join(dir, 'message'))
})
afterAll(async () => {
  await pool.query(
    "DELETE FROM messages WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
  await pool.end()
})

function writeShard(n: number, key: string): MessageDbWriter {
  return new MessageDbWriter(join(dir, 'message', `message_${n}.db`), key)
}

describe('collectGroup', () => {
  it('reads a group across two shards and stores each message once', async () => {
    const key = randomRawKey()
    const now = new Date('2026-09-30T00:00:00Z')
    const t = Math.floor(now.getTime() / 1000) - 100

    const w0 = writeShard(0, key)
    w0.add(GROUP, { serverId: BASE + 1n, sender: ALICE, createTime: t, content: `${ALICE}:\na` })
    w0.close()
    const w1 = writeShard(1, key)
    w1.add(GROUP, { serverId: BASE + 2n, sender: ALICE, createTime: t + 1, content: `${ALICE}:\nb` })
    w1.close()

    const keys = new Map([
      ['message/message_0.db', key],
      ['message/message_1.db', key],
    ])
    const { readers } = openShards(dir, keys)
    const stored = await collectGroup(readers, store, GROUP, now, options)
    readers.forEach((r) => r.close())

    expect(stored).toBe(2)
    const { rows } = await pool.query(
      'SELECT count(*) AS n FROM messages WHERE channel_id = $1',
      [GROUP],
    )
    expect(Number(rows[0].n)).toBe(2)
  })

  it('a second pass stores nothing new', async () => {
    const key = randomRawKey()
    const now = new Date('2026-09-30T00:00:00Z')
    const t = Math.floor(now.getTime() / 1000) - 100
    const w0 = writeShard(0, key)
    w0.add(GROUP, { serverId: BASE + 1n, sender: ALICE, createTime: t, content: `${ALICE}:\na` })
    w0.close()

    const keys = new Map([['message/message_0.db', key]])
    const first = openShards(dir, keys)
    await collectGroup(first.readers, store, GROUP, now, options)
    first.readers.forEach((r) => r.close())

    const second = openShards(dir, keys)
    const stored = await collectGroup(second.readers, store, GROUP, now, options)
    second.readers.forEach((r) => r.close())
    expect(stored).toBe(0)
  })
})

describe('collectOnce', () => {
  it('collects each group and reports its count', async () => {
    const key = randomRawKey()
    const now = new Date('2026-09-30T00:00:00Z')
    const t = Math.floor(now.getTime() / 1000) - 100
    const other = `${PREFIX}h@chatroom`
    const w0 = writeShard(0, key)
    w0.add(GROUP, { serverId: BASE + 1n, sender: ALICE, createTime: t, content: `${ALICE}:\na` })
    w0.add(other, { serverId: BASE + 2n, sender: ALICE, createTime: t, content: `${ALICE}:\nb` })
    w0.close()

    const { readers } = openShards(dir, new Map([['message/message_0.db', key]]))
    const result = await collectOnce(readers, store, [GROUP, other], now, options)
    readers.forEach((r) => r.close())

    expect(result.get(GROUP)).toBe(1)
    expect(result.get(other)).toBe(1)
  })
})
