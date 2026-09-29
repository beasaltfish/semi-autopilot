import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPool } from 'shared/db'
import { Retrieval } from './retrieval.js'

const pool = createPool({
  user: 'app_user',
  host: 'localhost',
  database: 'semi_autopilot',
  password: 'defaultpassword123',
  port: 5432,
})
const retrieval = new Retrieval(pool)

const PREFIX = 'test-retr-'
const GROUP = `${PREFIX}g@chatroom`
const BASE = 5_500_000_000_000_000_000n
let seq = 0

/** A 1536-dim unit vector with a 1 at position `i` — orthogonal for i≠j. */
function unit(i: number): number[] {
  const v = new Array(1536).fill(0)
  v[i] = 1
  return v
}

async function clean(): Promise<void> {
  await pool.query(
    "DELETE FROM messages WHERE source = 'wechat' AND channel_id LIKE $1",
    [`${PREFIX}%`],
  )
}
beforeEach(async () => {
  await clean()
  seq = 0
})
afterAll(async () => {
  await clean()
  await pool.end()
})

async function insert(authorId: string, content: string, embedding: number[]): Promise<void> {
  seq += 1
  await pool.query(
    `INSERT INTO messages
       (source, message_id, channel_id, space_id, author_id, author_name,
        content, timestamp, embedding)
     VALUES ('wechat', $1, $2, '', $3, $4, $5, NOW(), $6::vector)`,
    [(BASE + BigInt(seq)).toString(), GROUP, authorId, authorId, content, `[${embedding.join(',')}]`],
  )
}

describe('similarOwnerReplies', () => {
  it("returns the owner's nearest own messages first", async () => {
    await insert('wxid_me', 'near', unit(0))
    await insert('wxid_me', 'far', unit(9))
    await insert('wxid_other', 'not mine', unit(0))
    const replies = await retrieval.similarOwnerReplies(unit(0), 'wxid_me', 1)
    expect(replies).toEqual(['near'])
  })
})

describe('expertFor', () => {
  it('nominates the author who recurs among the nearest', async () => {
    await insert('wxid_expert', 'ans 1', unit(0))
    await insert('wxid_expert', 'ans 2', unit(0))
    await insert('wxid_other', 'one off', unit(0))
    const expert = await retrieval.expertFor(unit(0), GROUP, ['wxid_me', 'wxid_asker'], 5)
    expect(expert?.authorId).toBe('wxid_expert')
  })

  it('excludes the owner and the asker', async () => {
    await insert('wxid_me', 'a', unit(0))
    await insert('wxid_me', 'b', unit(0))
    await insert('wxid_asker', 'c', unit(0))
    await insert('wxid_asker', 'd', unit(0))
    const expert = await retrieval.expertFor(unit(0), GROUP, ['wxid_me', 'wxid_asker'], 5)
    expect(expert).toBeNull()
  })

  it('returns null when no one recurs', async () => {
    await insert('wxid_a', 'a', unit(0))
    await insert('wxid_b', 'b', unit(0))
    await insert('wxid_c', 'c', unit(0))
    const expert = await retrieval.expertFor(unit(0), GROUP, ['wxid_me'], 5)
    expect(expert).toBeNull()
  })
})
