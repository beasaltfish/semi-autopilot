import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { ResponderStore } from './store.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const store = new ResponderStore(pool)

const PREFIX = 'test-resp-'
const GROUP = `${PREFIX}g@chatroom`
// Disjoint message-id range from the other Postgres-backed test files.
const BASE = 6_000_000_000_000_000_000n

async function clean(): Promise<void> {
  // reply_decisions cascade-delete with their messages.
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

/** Insert a raw WeChat message; returns its messages.id. */
async function insertMessage(opts: {
  n: number
  authorId?: string
  authorName?: string
  content?: string
  timestamp?: Date
  replyTo?: bigint
}): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO messages
       (source, message_id, channel_id, space_id, author_id, author_name,
        content, timestamp, reply_to_message_id)
     VALUES ('wechat', $1, $2, '', $3, $4, $5, $6, $7) RETURNING id`,
    [
      (BASE + BigInt(opts.n)).toString(),
      GROUP,
      opts.authorId ?? 'wxid_a',
      opts.authorName ?? '路人',
      opts.content ?? '消息',
      opts.timestamp ?? new Date('2026-09-01T00:00:00Z'),
      opts.replyTo ? (BASE + opts.replyTo).toString() : null,
    ],
  )
  return rows[0].id
}

describe('claimUnjudged', () => {
  it('returns wechat messages that have no decision, oldest first', async () => {
    await insertMessage({ n: 2, content: 'later', timestamp: new Date('2026-09-02T00:00:00Z') })
    await insertMessage({ n: 1, content: 'earlier', timestamp: new Date('2026-09-01T00:00:00Z') })
    const claimed = (await store.claimUnjudged(50)).filter((c) => c.channelId === GROUP)
    expect(claimed.map((c) => c.content)).toEqual(['earlier', 'later'])
    // Ascending by time, whatever the column's timezone handling.
    expect(claimed[0].timestamp.getTime()).toBeLessThan(claimed[1].timestamp.getTime())
  })

  it('resolves the quoted author', async () => {
    await insertMessage({ n: 1, authorId: 'wxid_me' })
    await insertMessage({ n: 2, authorId: 'wxid_b', replyTo: 1n })
    const claimed = (await store.claimUnjudged(50)).filter((c) => c.channelId === GROUP)
    const reply = claimed.find((c) => c.authorId === 'wxid_b')
    expect(reply?.replyToAuthorId).toBe('wxid_me')
  })

  it('does not re-claim a message that already has a decision', async () => {
    const id = await insertMessage({ n: 1 })
    await store.recordDecision({ messageId: id, stage: 'jev', route: 'record_only' })
    const claimed = (await store.claimUnjudged(50)).filter((c) => c.channelId === GROUP)
    expect(claimed).toHaveLength(0)
  })
})

describe('recordDecision', () => {
  it('is idempotent per message', async () => {
    const id = await insertMessage({ n: 1 })
    const first = await store.recordDecision({ messageId: id, stage: 'llm', route: 'draft', draft: 'hi' })
    const second = await store.recordDecision({ messageId: id, stage: 'llm', route: 'draft' })
    expect(second).toBe(first)
  })
})

describe('feedback and expiry', () => {
  it('records feedback by the telegram message id', async () => {
    const id = await insertMessage({ n: 1 })
    const decisionId = await store.recordDecision({ messageId: id, stage: 'llm', route: 'draft', draft: 'hi' })
    await store.attachTelegramId(decisionId, 555)
    await store.recordFeedback(555, 'edit', '改过的')

    const { rows } = await pool.query(
      'SELECT feedback, edited_text FROM reply_decisions WHERE id = $1',
      [decisionId],
    )
    expect(rows[0]).toMatchObject({ feedback: 'edit', edited_text: '改过的' })
  })

  it('expires only pushed, unanswered, old cards', async () => {
    const old = await insertMessage({ n: 1 })
    const oldDecision = await store.recordDecision({ messageId: old, stage: 'llm', route: 'draft' })
    await store.attachTelegramId(oldDecision, 100)
    await pool.query(
      "UPDATE reply_decisions SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [oldDecision],
    )
    const answered = await insertMessage({ n: 2 })
    const answeredDecision = await store.recordDecision({ messageId: answered, stage: 'llm', route: 'draft' })
    await store.attachTelegramId(answeredDecision, 200)
    await store.recordFeedback(200, 'approve')
    await pool.query(
      "UPDATE reply_decisions SET created_at = NOW() - INTERVAL '1 hour' WHERE id = $1",
      [answeredDecision],
    )

    const expired = await store.expireStale(new Date(Date.now() - 30 * 60_000))
    expect(expired.map((e) => e.telegramMessageId)).toEqual([100])
  })
})

describe('rate limit and cooldown', () => {
  it('counts drafts and templates in a group within the window', async () => {
    const a = await insertMessage({ n: 1 })
    const b = await insertMessage({ n: 2 })
    const c = await insertMessage({ n: 3 })
    await store.recordDecision({ messageId: a, stage: 'llm', route: 'draft' })
    await store.recordDecision({ messageId: b, stage: 'template', route: 'template' })
    await store.recordDecision({ messageId: c, stage: 'jev', route: 'record_only' })
    const n = await store.draftsInGroupSince(GROUP, new Date(Date.now() - 60 * 60_000))
    expect(n).toBe(2)
  })

  it('lists templates already used for a person', async () => {
    const a = await insertMessage({ n: 1, authorId: 'wxid_p' })
    await store.recordDecision({ messageId: a, stage: 'template', route: 'template', draft: '谢谢支持' })
    const used = await store.templatesUsedFor('wxid_p', new Date(Date.now() - 60 * 60_000))
    expect(used).toEqual(['谢谢支持'])
  })
})
