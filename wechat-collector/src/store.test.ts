import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import type { DecodedMessage } from './decode.js'
import { CollectorStore } from './store.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new CollectorStore(pool)

// Test groups share this prefix so cleanup never touches real rows.
const PREFIX = 'test-collector-'
const GROUP = `${PREFIX}1@chatroom`

async function clean(): Promise<void> {
  await pool.query(
    "DELETE FROM messages WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
  await pool.query(
    "DELETE FROM channels WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
}

function message(overrides: Partial<DecodedMessage> = {}): DecodedMessage {
  return {
    messageId: '2031611702689809518',
    authorId: 'wxid_alice',
    content: 'hello',
    timestamp: new Date('2026-09-01T00:00:00Z'),
    rawData: { kind: 'text', mentions: [] },
    ...overrides,
  }
}

beforeEach(clean)
afterAll(async () => {
  await clean()
  await pool.end()
})

describe('enableGroups', () => {
  it('records a group as an enabled channel', async () => {
    await store.enableGroups([GROUP])
    const { rows } = await pool.query(
      "SELECT enabled FROM channels WHERE source = 'wechat' AND channel_id = $1",
      [GROUP],
    )
    expect(rows[0].enabled).toBe(true)
  })

  it('is idempotent — a second call does not error', async () => {
    await store.enableGroups([GROUP])
    await store.enableGroups([GROUP])
    const { rows } = await pool.query(
      "SELECT count(*) AS n FROM channels WHERE source = 'wechat' AND channel_id = $1",
      [GROUP],
    )
    expect(Number(rows[0].n)).toBe(1)
  })
})

describe('insertMessages', () => {
  it('stores a message with the WeChat mapping', async () => {
    const inserted = await store.insertMessages(GROUP, [message()])
    expect(inserted).toBe(1)
    const { rows } = await pool.query(
      "SELECT source, space_id, author_id, content FROM messages WHERE channel_id = $1",
      [GROUP],
    )
    expect(rows[0]).toMatchObject({
      source: 'wechat',
      space_id: '',
      author_id: 'wxid_alice',
      content: 'hello',
    })
  })

  it('preserves a server_id past 2^53 exactly', async () => {
    await store.insertMessages(GROUP, [message()])
    const { rows } = await pool.query(
      'SELECT message_id FROM messages WHERE channel_id = $1',
      [GROUP],
    )
    expect(rows[0].message_id).toBe('2031611702689809518')
  })

  it('ignores a message already stored and counts only the new', async () => {
    await store.insertMessages(GROUP, [message()])
    const second = await store.insertMessages(GROUP, [
      message(),
      message({ messageId: '999', timestamp: new Date('2026-09-02T00:00:00Z') }),
    ])
    // The first is a duplicate; only the second row is new.
    expect(second).toBe(1)
    const { rows } = await pool.query(
      'SELECT count(*) AS n FROM messages WHERE channel_id = $1',
      [GROUP],
    )
    expect(Number(rows[0].n)).toBe(2)
  })

  it('returns 0 for an empty batch without touching the database', async () => {
    expect(await store.insertMessages(GROUP, [])).toBe(0)
  })
})

describe('newestTimestamp', () => {
  it('is null before anything is stored', async () => {
    expect(await store.newestTimestamp(GROUP)).toBeNull()
  })

  it('returns the latest stored message time for the group', async () => {
    await store.insertMessages(GROUP, [
      message({ messageId: '1', timestamp: new Date('2026-09-01T00:00:00Z') }),
      message({ messageId: '2', timestamp: new Date('2026-09-03T00:00:00Z') }),
      message({ messageId: '3', timestamp: new Date('2026-09-02T00:00:00Z') }),
    ])
    expect(await store.newestTimestamp(GROUP)).toEqual(
      new Date('2026-09-03T00:00:00Z'),
    )
  })
})
