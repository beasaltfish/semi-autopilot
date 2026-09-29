import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import type { DecodedMessage } from './decode.js'
import { embedPending, type EmbedStore } from './embed.js'
import type { PendingEmbedding } from './store.js'
import { CollectorStore } from './store.js'

/** A fake embedder: one deterministic 1536-vector per input, in order. */
function fakeEmbed(dim = 1536) {
  const calls: string[][] = []
  const embed = async (texts: string[]): Promise<number[][]> => {
    calls.push(texts)
    return texts.map(() => Array(dim).fill(0.01))
  }
  return { embed, calls }
}

describe('embedPending batching', () => {
  // An in-memory store, so the batch contract is tested without a database and
  // without interference from other rows.
  function fakeStore(contents: string[]): EmbedStore {
    let pending: PendingEmbedding[] = contents.map((content, id) => ({
      id,
      content,
    }))
    return {
      async pendingEmbedding(_minChars, limit) {
        return pending.slice(0, limit)
      },
      async setEmbeddings(entries) {
        const done = new Set(entries.map((e) => e.id))
        pending = pending.filter((row) => !done.has(row.id))
      },
    }
  }

  it('embeds a batch and reports its size', async () => {
    const { embed } = fakeEmbed()
    const store = fakeStore(['a', 'b', 'c'])
    expect(await embedPending(embed, store, { minChars: 4, batchSize: 2 })).toBe(2)
    expect(await embedPending(embed, store, { minChars: 4, batchSize: 2 })).toBe(1)
    expect(await embedPending(embed, store, { minChars: 4, batchSize: 2 })).toBe(0)
  })

  it('does not call the embedder when nothing is pending', async () => {
    const { embed, calls } = fakeEmbed()
    expect(await embedPending(embed, fakeStore([]), { minChars: 4, batchSize: 2 })).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

// Against the real store, checking the length filter and the write, scoped to
// this test's own group so other pending rows do not matter.
const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new CollectorStore(pool)
const PREFIX = 'test-embed-'
const GROUP = `${PREFIX}g@chatroom`
const BASE = 7_000_000_000_000_000_000n

async function clean(): Promise<void> {
  await pool.query(
    "DELETE FROM messages WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
}
beforeEach(clean)
afterAll(async () => {
  await clean()
  await pool.end()
})

function message(i: number, content: string): DecodedMessage {
  return {
    messageId: (BASE + BigInt(i)).toString(),
    authorId: 'wxid_alice',
    content,
    timestamp: new Date('2026-09-01T00:00:00Z'),
    rawData: { kind: 'text', mentions: [] },
  }
}

/** Embed everything pending, so this group's rows are covered regardless of order. */
async function drain(): Promise<void> {
  const { embed } = fakeEmbed()
  while ((await embedPending(embed, store, { minChars: 4, batchSize: 64 })) > 0);
}

async function embeddedContents(): Promise<string[]> {
  const { rows } = await pool.query(
    "SELECT content FROM messages WHERE channel_id = $1 AND embedding IS NOT NULL ORDER BY message_id",
    [GROUP],
  )
  return rows.map((r) => r.content)
}

describe('embedPending against the store', () => {
  it('embeds messages at or above the length floor, not below', async () => {
    await store.insertMessages(GROUP, [
      message(1, '历史作业交了吗'), // 7 chars
      message(2, '哈'), // 1 char, below the floor
    ])
    await drain()
    expect(await embeddedContents()).toEqual(['历史作业交了吗'])
  })

  it('leaves an embedded message alone on a later pass', async () => {
    await store.insertMessages(GROUP, [message(1, '这是一条足够长的消息')])
    await drain()
    const first = await pool.query(
      "SELECT embedding FROM messages WHERE channel_id = $1",
      [GROUP],
    )
    await drain()
    const second = await pool.query(
      "SELECT embedding FROM messages WHERE channel_id = $1",
      [GROUP],
    )
    expect(second.rows[0].embedding).toEqual(first.rows[0].embedding)
  })
})
