import { describe, expect, it, vi } from 'vitest'
import { TelegramBot } from './bot.js'

const config = { botToken: 'tok', chatId: '42' }

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('TelegramBot.send', () => {
  it('posts the card and returns the message id', async () => {
    const fetchImpl = vi.fn(async () => ok({ message_id: 555 }))
    const bot = new TelegramBot(config, fetchImpl as unknown as typeof fetch)
    const id = await bot.send({ text: 'hi', reply_markup: { inline_keyboard: [] } })
    expect(id).toBe(555)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/bottok/sendMessage')
    expect(JSON.parse(init.body as string)).toMatchObject({ chat_id: '42', text: 'hi' })
  })
})

describe('TelegramBot.poll', () => {
  it('surfaces the owner callback and advances the offset', async () => {
    const fetchImpl = async () =>
      ok([
        {
          update_id: 10,
          callback_query: { id: 'cb1', data: 'a:7', message: { message_id: 100, chat: { id: 42 } } },
        },
      ])
    const bot = new TelegramBot(config, fetchImpl as unknown as typeof fetch)
    const { nextOffset, events } = await bot.poll(0)
    expect(nextOffset).toBe(11)
    expect(events).toEqual([{ kind: 'callback', callbackId: 'cb1', data: 'a:7', messageId: 100 }])
  })

  it('ignores updates from another chat but still advances', async () => {
    const fetchImpl = async () =>
      ok([
        {
          update_id: 20,
          callback_query: { id: 'x', data: 'a:1', message: { message_id: 1, chat: { id: 999 } } },
        },
      ])
    const bot = new TelegramBot(config, fetchImpl as unknown as typeof fetch)
    const { nextOffset, events } = await bot.poll(0)
    expect(events).toEqual([])
    expect(nextOffset).toBe(21)
  })

  it('surfaces an owner text reply', async () => {
    const fetchImpl = async () =>
      ok([{ update_id: 30, message: { chat: { id: 42 }, text: '改成这样' } }])
    const bot = new TelegramBot(config, fetchImpl as unknown as typeof fetch)
    const { events } = await bot.poll(0)
    expect(events).toEqual([{ kind: 'text', text: '改成这样' }])
  })
})
