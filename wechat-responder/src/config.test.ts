import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  OPENROUTER_API_KEY: 'k',
  WECHAT_OWNER_ID: 'wxid_me',
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_CHAT_ID: 'c',
  LLM_MODEL: 'some-model',
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('reads owner id and names and applies threshold defaults', () => {
    const config = loadConfig({ ...base, WECHAT_OWNER_NAMES: '老张, 张老师 ,老张' })
    expect(config.ownerId).toBe('wxid_me')
    expect(config.ownerNames).toEqual(['老张', '张老师'])
    expect(config.thresholds).toEqual({
      intentMin: 0.6,
      praiseMin: 0.7,
      addressedMin: 0.6,
    })
  })

  it('applies the rate and timing defaults', () => {
    const config = loadConfig(base)
    expect(config.draftsPerGroupPerHour).toBe(4)
    expect(config.templateCooldownMinutes).toBe(180)
    expect(config.cardExpiryMinutes).toBe(30)
    expect(config.pollSeconds).toBe(15)
  })

  it('reads the telegram bot and the owner chat', () => {
    expect(loadConfig(base).telegram).toEqual({ botToken: 't', chatId: 'c' })
  })

  it('requires the draft model', () => {
    const { LLM_MODEL: _omit, ...withoutModel } = base
    expect(() => loadConfig(withoutModel as NodeJS.ProcessEnv)).toThrow('LLM_MODEL')
  })

  it('requires the owner id and the telegram chat', () => {
    const { WECHAT_OWNER_ID: _a, ...noOwner } = base
    expect(() => loadConfig(noOwner as NodeJS.ProcessEnv)).toThrow('WECHAT_OWNER_ID')
    const { TELEGRAM_CHAT_ID: _b, ...noChat } = base
    expect(() => loadConfig(noChat as NodeJS.ProcessEnv)).toThrow('TELEGRAM_CHAT_ID')
  })

  it('rejects a threshold outside 0..1', () => {
    expect(() => loadConfig({ ...base, INTENT_MIN: '1.5' })).toThrow('INTENT_MIN')
  })
})
