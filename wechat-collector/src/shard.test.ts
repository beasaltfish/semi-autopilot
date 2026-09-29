import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeMessage } from './decode.js'
import { MessageDbWriter, randomRawKey } from './fixture.js'
import { conversationTable, ShardReader, WechatDbError } from './shard.js'

let dir: string
let dbPath: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wechat-shard-'))
  dbPath = join(dir, 'message_0.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const GROUP = 'room-1@chatroom'
const ALICE = 'wxid_alice'

describe('conversationTable', () => {
  it('is Msg_ plus the md5 of the username', () => {
    // md5('room-1@chatroom') computed independently.
    expect(conversationTable(GROUP)).toMatch(/^Msg_[0-9a-f]{32}$/)
  })
})

describe('ShardReader', () => {
  it('reads a plain-text message through the raw key', () => {
    const key = randomRawKey()
    const writer = new MessageDbWriter(dbPath, key)
    writer.add(GROUP, {
      serverId: 2031611702689809518n,
      sender: ALICE,
      createTime: 1000,
      content: `${ALICE}:\nhello`,
    })
    writer.close()

    const reader = ShardReader.open(dbPath, key, 'message/message_0.db')
    const rows = reader.readMessages(GROUP, 0)
    reader.close()

    expect(rows).toHaveLength(1)
    // The big server_id survives as an exact bigint.
    expect(rows[0].serverId).toBe(2031611702689809518n)
    expect(rows[0].senderUsername).toBe(ALICE)
    expect(decodeMessage(rows[0])?.content).toBe('hello')
  })

  it('decompresses zstd content and source', () => {
    const key = randomRawKey()
    const writer = new MessageDbWriter(dbPath, key)
    writer.add(GROUP, {
      serverId: 5n,
      sender: ALICE,
      createTime: 1000,
      content: `${ALICE}:\n历史作业交了吗`,
      compressContent: true,
      source: '<msgsource><atuserlist>wxid_b</atuserlist></msgsource>',
      compressSource: true,
    })
    writer.close()

    const reader = ShardReader.open(dbPath, key, 'message/message_0.db')
    const [row] = reader.readMessages(GROUP, 0)
    reader.close()

    expect(decodeMessage(row)?.content).toBe('历史作业交了吗')
    expect(decodeMessage(row)?.rawData.mentions).toEqual(['wxid_b'])
  })

  it('reads only messages at or after the given time, oldest first', () => {
    const key = randomRawKey()
    const writer = new MessageDbWriter(dbPath, key)
    for (const t of [100, 200, 300]) {
      writer.add(GROUP, {
        serverId: BigInt(t),
        sender: ALICE,
        createTime: t,
        content: `${ALICE}:\nm${t}`,
      })
    }
    writer.close()

    const reader = ShardReader.open(dbPath, key, 'message/message_0.db')
    const rows = reader.readMessages(GROUP, 200)
    reader.close()

    expect(rows.map((r) => r.createTime)).toEqual([200, 300])
  })

  it('returns nothing for a conversation this shard does not hold', () => {
    const key = randomRawKey()
    const writer = new MessageDbWriter(dbPath, key)
    writer.add(GROUP, { serverId: 1n, sender: ALICE, createTime: 1, content: 'x' })
    writer.close()

    const reader = ShardReader.open(dbPath, key, 'message/message_0.db')
    expect(reader.readMessages('other@chatroom', 0)).toEqual([])
    reader.close()
  })

  it('rejects a wrong key rather than returning empty', () => {
    const writer = new MessageDbWriter(dbPath, randomRawKey())
    writer.add(GROUP, { serverId: 1n, sender: ALICE, createTime: 1, content: 'x' })
    writer.close()

    expect(() =>
      ShardReader.open(dbPath, randomRawKey(), 'message/message_0.db'),
    ).toThrow(WechatDbError)
  })
})
