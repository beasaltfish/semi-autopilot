import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const base = {
  WECHAT_DB_DIR: '/tmp/db_storage',
  WECHAT_KEYS_PATH: '/tmp/keys.json',
} as NodeJS.ProcessEnv

describe('loadConfig', () => {
  it('applies the defaults', () => {
    expect(loadConfig(base)).toEqual({
      dbDir: '/tmp/db_storage',
      keysPath: '/tmp/keys.json',
      groups: [],
      pollSeconds: 10,
      overlapSeconds: 300,
      backfillDays: 30,
      embedding: null,
      notify: null,
    })
  })

  it('requires the database directory and the keys file', () => {
    expect(() => loadConfig({ WECHAT_KEYS_PATH: '/k' } as NodeJS.ProcessEnv)).toThrow(
      'WECHAT_DB_DIR',
    )
    expect(() => loadConfig({ WECHAT_DB_DIR: '/d' } as NodeJS.ProcessEnv)).toThrow(
      'WECHAT_KEYS_PATH',
    )
  })

  it('reads the allowlist, trimmed and deduplicated', () => {
    const config = loadConfig({
      ...base,
      WECHAT_GROUPS: ' 1@chatroom, 2@chatroom ,1@chatroom,',
    })
    expect(config.groups).toEqual(['1@chatroom', '2@chatroom'])
  })

  it('rejects an allowlist entry that is not a group', () => {
    // A wxid here would be a private chat, which phase 1 excludes.
    expect(() =>
      loadConfig({ ...base, WECHAT_GROUPS: 'wxid_someone' }),
    ).toThrow('@chatroom')
  })

  it('rejects a poll interval that is not a positive integer', () => {
    expect(() => loadConfig({ ...base, WECHAT_POLL_SECONDS: '0' })).toThrow(
      'WECHAT_POLL_SECONDS',
    )
  })

  it('configures embedding only when a model is named', () => {
    const config = loadConfig({ ...base, EMBEDDING_MODEL: 'text-embedding-3-small' })
    expect(config.embedding).toEqual({
      baseUrl: 'http://localhost:20128/v1',
      apiKey: null,
      model: 'text-embedding-3-small',
      embeddingModel: 'text-embedding-3-small',
      timeoutMs: 120_000,
      minChars: 4,
    })
  })

  it('picks Telegram when both halves are set', () => {
    const config = loadConfig({
      ...base,
      TELEGRAM_BOT_TOKEN: 't',
      TELEGRAM_CHAT_ID: 'c',
    })
    expect(config.notify).toEqual({ kind: 'telegram', botToken: 't', chatId: 'c' })
  })
})
