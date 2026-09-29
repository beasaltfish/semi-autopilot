import { describe, expect, it } from 'vitest'
import { applyRules, type MessageInput } from './rules.js'

const owner = { id: 'wxid_me', names: ['老张'] }
const base: MessageInput = {
  authorId: 'wxid_a',
  content: '你好',
  rawData: { kind: 'text', mentions: [] },
  replyToAuthorId: null,
}

describe('applyRules', () => {
  it("drops the owner's own message", () => {
    expect(applyRules({ ...base, authorId: 'wxid_me' }, owner)).toEqual({ drop: 'own' })
  })

  it('drops a system message and a sticker', () => {
    expect(applyRules({ ...base, rawData: { kind: 'system' } }, owner)).toEqual({ drop: 'system' })
    expect(applyRules({ ...base, rawData: { kind: 'sticker' } }, owner)).toEqual({ drop: 'sticker' })
  })

  it('flags an @ of the owner', () => {
    expect(applyRules({ ...base, rawData: { mentions: ['wxid_me'] } }, owner)).toEqual({
      flags: { mentionsOwner: true, mentionsOther: false, quotesOwner: false, namesOwner: false },
    })
  })

  it('flags an @ of someone else as mentionsOther', () => {
    expect(applyRules({ ...base, rawData: { mentions: ['wxid_b'] } }, owner)).toMatchObject({
      flags: { mentionsOwner: false, mentionsOther: true },
    })
  })

  it('flags an @ of both the owner and another', () => {
    expect(
      applyRules({ ...base, rawData: { mentions: ['wxid_me', 'wxid_b'] } }, owner),
    ).toMatchObject({ flags: { mentionsOwner: true, mentionsOther: true } })
  })

  it('flags a reply that quotes the owner', () => {
    expect(applyRules({ ...base, replyToAuthorId: 'wxid_me' }, owner)).toMatchObject({
      flags: { quotesOwner: true },
    })
  })

  it("flags the owner's name in the text", () => {
    expect(applyRules({ ...base, content: '这个问题问老张吧' }, owner)).toMatchObject({
      flags: { namesOwner: true },
    })
  })

  it('treats a null rawData as no mentions', () => {
    expect(applyRules({ ...base, rawData: null }, owner)).toMatchObject({
      flags: { mentionsOwner: false, mentionsOther: false },
    })
  })
})
