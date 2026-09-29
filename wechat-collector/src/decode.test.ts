import { describe, expect, it } from 'vitest'
import { decodeMessage, messageType, type RawMessage } from './decode.js'

const OWNER = 'wxid_owner'
const ALICE = 'wxid_alice'

function raw(overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    serverId: 100n,
    localType: 1n,
    senderUsername: ALICE,
    createTime: 1_790_000_000,
    content: `${ALICE}:\nhello`,
    source: null,
    ...overrides,
  }
}

describe('messageType', () => {
  it('splits the packed local_type into type and subtype', () => {
    expect(messageType(1n)).toEqual({ type: 1, subType: 0 })
    // A quoted reply is 49/57: type 49 low, subtype 57 high.
    expect(messageType((57n << 32n) | 49n)).toEqual({ type: 49, subType: 57 })
  })
})

describe('decodeMessage', () => {
  it('strips the sender prefix from a group message', () => {
    expect(decodeMessage(raw())?.content).toBe('hello')
  })

  it('leaves a private-chat text untouched (no prefix)', () => {
    expect(decodeMessage(raw({ content: 'hello' }))?.content).toBe('hello')
  })

  it("keeps the owner's text whose first line looks like a prefix", () => {
    // The owner's own messages carry no `sender:\n`, so a colon-newline that
    // is not the sender must survive.
    const decoded = decodeMessage(
      raw({ senderUsername: OWNER, content: 'todo:\nbuy milk' }),
    )
    expect(decoded?.content).toBe('todo:\nbuy milk')
  })

  it('carries the server id across as an exact string, past 2^53', () => {
    const decoded = decodeMessage(raw({ serverId: 2031611702689809518n }))
    expect(decoded?.messageId).toBe('2031611702689809518')
  })

  it('maps create_time seconds to a Date', () => {
    expect(decodeMessage(raw({ createTime: 1_790_000_000 }))?.timestamp).toEqual(
      new Date(1_790_000_000_000),
    )
  })

  it('reads the @-mention list from the source xml', () => {
    const source = '<msgsource><atuserlist>wxid_a,wxid_b</atuserlist></msgsource>'
    expect(decodeMessage(raw({ source }))?.rawData.mentions).toEqual([
      'wxid_a',
      'wxid_b',
    ])
  })

  it('has no mentions when the source has no atuserlist', () => {
    const source = '<msgsource><membercount>3</membercount></msgsource>'
    expect(decodeMessage(raw({ source }))?.rawData.mentions).toEqual([])
  })

  it('skips a non-text message', () => {
    // 47 is a sticker; v1 does not store it.
    expect(decodeMessage(raw({ localType: 47n }))).toBeNull()
  })

  it('skips a text row that carries no content', () => {
    expect(decodeMessage(raw({ content: null }))).toBeNull()
  })
})
