import { describe, expect, it } from 'vitest'
import {
  alertCard,
  draftCard,
  encodeCallback,
  parseCallback,
} from './card.js'

const jev = {
  intent: { label: 'question', confidence: 0.91 },
  addressed: { label: 'true', confidence: 0.8 },
}

describe('callback encoding', () => {
  it('round-trips an action and decision id', () => {
    for (const action of ['approve', 'reject', 'edit', 'ack'] as const) {
      const encoded = encodeCallback({ action, decisionId: 123 })
      expect(encoded.length).toBeLessThanOrEqual(64)
      expect(parseCallback(encoded)).toEqual({ action, decisionId: 123 })
    }
  })

  it('rejects junk', () => {
    expect(parseCallback('nonsense')).toBeNull()
    expect(parseCallback('a:notanumber')).toBeNull()
  })
})

describe('draftCard', () => {
  it('shows three buttons, the judgement line and the draft', () => {
    const card = draftCard({
      decisionId: 7,
      group: '家长群',
      sender: '小王',
      message: '作业交了吗',
      jev,
      mentionName: null,
      draft: '交过啦',
    })
    expect(card.reply_markup.inline_keyboard[0]).toHaveLength(3)
    expect(card.text).toContain('question 0.91')
    expect(card.text).toContain('草稿：交过啦')
  })

  it('shows the @ suggestion and a no-draft note when there is no draft', () => {
    const card = draftCard({
      decisionId: 7,
      group: 'g',
      sender: 's',
      message: 'm',
      jev,
      mentionName: '李工',
      draft: null,
    })
    expect(card.text).toContain('建议 @李工')
    expect(card.text).toContain('没有草稿')
  })
})

describe('alertCard', () => {
  it('has a single ack button and a probe heading', () => {
    const card = alertCard({
      decisionId: 9,
      group: 'g',
      sender: 's',
      message: '你是机器人吗',
      reason: 'ai_probe',
      jev,
    })
    expect(card.reply_markup.inline_keyboard).toEqual([
      [{ text: '知道了', callback_data: 'k:9' }],
    ])
    expect(card.text).toContain('试探')
  })
})
