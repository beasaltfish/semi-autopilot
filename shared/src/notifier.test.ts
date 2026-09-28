import { describe, expect, it, vi } from 'vitest'
import { loadNotifyTarget, notifyAttention, notifyFailure } from './notifier.js'

describe('notifyFailure', () => {
  it('posts the message to the webhook under the service name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyFailure(
      'https://example.test/hook',
      'x-poster',
      'session expired',
      fetchImpl as never,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://example.test/hook')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.username).toBe('x-poster')
    expect(body.content).toContain('session expired')
    expect(body.content).toContain('x-poster')
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyFailure(null, 'x-poster', 'session expired', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    // A broken notification must not mask the failure it was reporting.
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyFailure(
        'https://example.test/hook',
        'x-poster',
        'session expired',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('notifyAttention', () => {
  async function contentOf(
    notify: typeof notifyAttention,
  ): Promise<string> {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notify(
      'https://example.test/hook',
      'x-poster',
      'log in and I will carry on',
      fetchImpl as never,
    )
    const [, init] = fetchImpl.mock.calls[0]!
    return JSON.parse((init as RequestInit).body as string).content
  }

  it('carries the message under the service name', async () => {
    const content = await contentOf(notifyAttention)
    expect(content).toContain('log in and I will carry on')
    expect(content).toContain('x-poster')
  })

  /**
   * The whole reason this is not `notifyFailure`. Saying "stopped" about a
   * process that is still running and will resume by itself costs someone a
   * trip to the machine to discover nothing was wrong.
   */
  it('does not claim the service stopped', async () => {
    expect(await contentOf(notifyAttention)).not.toContain('stopped')
    expect(await contentOf(notifyFailure)).toContain('stopped')
  })

  it('does nothing when no webhook is configured', async () => {
    const fetchImpl = vi.fn()
    await notifyAttention(null, 'x-poster', 'log in', fetchImpl as never)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('swallows a webhook failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('webhook down'))
    await expect(
      notifyAttention(
        'https://example.test/hook',
        'x-poster',
        'log in',
        fetchImpl as never,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('Telegram target', () => {
  const telegram = {
    kind: 'telegram' as const,
    botToken: '123:abc',
    chatId: '42',
  }

  it('posts to sendMessage for the configured chat', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyFailure(
      telegram,
      'wechat-collector',
      'chatlog down',
      fetchImpl as never,
    )

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.chat_id).toBe('42')
    expect(body.text).toContain('wechat-collector')
    expect(body.text).toContain('chatlog down')
  })

  it('sends plain text, not Discord markdown', async () => {
    // No parse_mode: Telegram's MarkdownV2 rejects any unescaped `.` or `-`,
    // and an error message is full of both.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyAttention(
      telegram,
      'wechat-collector',
      'log in',
      fetchImpl as never,
    )

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body).not.toHaveProperty('parse_mode')
    expect(body.text).not.toContain('**')
    expect(body.text).not.toContain('stopped')
  })

  it('truncates a message Telegram would reject for length', async () => {
    // Telegram refuses anything over 4096 characters outright. A long stack
    // trace should arrive cut short, not vanish.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 })
    await notifyFailure(telegram, 'svc', 'x'.repeat(10_000), fetchImpl as never)

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body.text.length).toBeLessThanOrEqual(4096)
    expect(body.text).toContain('…')
  })

  it('swallows a Telegram failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('telegram down'))
    await expect(
      notifyFailure(telegram, 'svc', 'boom', fetchImpl as never),
    ).resolves.toBeUndefined()
  })
})

describe('Discord target given as an object', () => {
  it('behaves exactly like the bare webhook string', async () => {
    const asString = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    const asObject = vi.fn().mockResolvedValue({ ok: true, status: 204 })
    await notifyFailure(
      'https://example.test/hook',
      'svc',
      'm',
      asString as never,
    )
    await notifyFailure(
      { kind: 'discord', webhookUrl: 'https://example.test/hook' },
      'svc',
      'm',
      asObject as never,
    )
    expect(asObject.mock.calls).toEqual(asString.mock.calls)
  })
})

describe('loadNotifyTarget', () => {
  it('prefers Telegram when both halves are set', () => {
    expect(
      loadNotifyTarget({
        TELEGRAM_BOT_TOKEN: 't',
        TELEGRAM_CHAT_ID: '1',
        DISCORD_WEBHOOK_URL: 'https://example.test/hook',
      } as NodeJS.ProcessEnv),
    ).toEqual({ kind: 'telegram', botToken: 't', chatId: '1' })
  })

  it('falls back to Discord when Telegram is half-configured', () => {
    expect(
      loadNotifyTarget({
        TELEGRAM_BOT_TOKEN: 't',
        DISCORD_WEBHOOK_URL: 'https://example.test/hook',
      } as NodeJS.ProcessEnv),
    ).toEqual({ kind: 'discord', webhookUrl: 'https://example.test/hook' })
  })

  it('returns null when nothing is configured', () => {
    expect(loadNotifyTarget({} as NodeJS.ProcessEnv)).toBeNull()
  })
})
