import { describe, expect, it, vi } from 'vitest'
import { buildPrompt, draftReply, validate, type DraftInput } from './draft.js'

const input: DraftInput = {
  message: '这个报错怎么解决',
  context: [{ authorName: '小王', content: '大家好' }],
  retrieved: [],
  mentionName: null,
  styleRules: ['不要用感叹号堆叠', '不自称助手'],
  fewShot: ['你把日志发一下', '重启试试'],
}

const opts = { maxChars: 200, banned: ['作为一个 AI', '希望对你有帮助'] }

describe('buildPrompt', () => {
  it('includes the style rules, the message, and the voice samples', () => {
    const [system, user] = buildPrompt(input)
    expect(system.content).toContain('不要用感叹号堆叠')
    expect(user.content).toContain('这个报错怎么解决')
    expect(user.content).toContain('重启试试')
  })

  it('asks to hand off when a mention name is given', () => {
    const [, user] = buildPrompt({ ...input, mentionName: '李工' })
    expect(user.content).toContain('@李工')
  })
})

describe('validate', () => {
  it('accepts a clean short reply', () => {
    expect(validate('你把日志发一下', opts)).toEqual({ ok: true })
  })
  it('rejects a banned phrase', () => {
    expect(validate('作为一个 AI，我建议…', opts)).toMatchObject({ ok: false })
  })
  it('rejects an over-length reply', () => {
    expect(validate('字'.repeat(201), opts)).toMatchObject({ ok: false, reason: 'too long' })
  })
  it('rejects an empty reply', () => {
    expect(validate('   ', opts)).toMatchObject({ ok: false, reason: 'empty' })
  })
})

describe('draftReply', () => {
  it('returns a clean draft on the first try', async () => {
    const chat = vi.fn(async () => '重启一下试试')
    const result = await draftReply({ chat }, input, opts)
    expect(result).toEqual({ text: '重启一下试试' })
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('regenerates once when the first draft is banned', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('作为一个 AI，希望对你有帮助')
      .mockResolvedValueOnce('你把日志发我看看')
    const result = await draftReply({ chat }, input, opts)
    expect(result).toEqual({ text: '你把日志发我看看' })
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('gives up after a second failure', async () => {
    const chat = vi.fn(async () => '作为一个 AI 助手')
    const result = await draftReply({ chat }, input, opts)
    expect(result).toEqual({ failed: true })
    expect(chat).toHaveBeenCalledTimes(2)
  })
})
