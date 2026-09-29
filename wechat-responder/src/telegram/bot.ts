/**
 * The Telegram side, over the Bot API with long polling — so the Mac needs no
 * public endpoint. Only the owner's chat is honoured; every other update is
 * dropped. This holds no pipeline logic: it sends cards, edits them on expiry,
 * and surfaces the owner's callbacks and text replies for the loop to act on.
 */
import type { CardPayload } from './card.js'

/** A callback press, or a plain text reply (which may be an edited draft). */
export interface TelegramEvent {
  kind: 'callback' | 'text'
  /** For a callback: the id to acknowledge. */
  callbackId?: string
  /** For a callback: the raw callback_data. */
  data?: string
  /** For a callback: the id of the card the button is on. */
  messageId?: number
  /** For a text reply: its body. */
  text?: string
}

interface Update {
  update_id: number
  message?: { chat: { id: number }; text?: string }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

export class TelegramBot {
  constructor(
    private readonly config: { botToken: string; chatId: string },
    private readonly fetchImpl: typeof fetch = fetch,
    /** Long-poll seconds handed to getUpdates. */
    private readonly pollTimeoutSeconds = 25,
  ) {}

  private async call(method: string, payload: unknown): Promise<unknown> {
    const response = await this.fetchImpl(
      `https://api.telegram.org/bot${this.config.botToken}/${method}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout((this.pollTimeoutSeconds + 10) * 1000),
      },
    )
    const body = (await response.json()) as { ok: boolean; result?: unknown; description?: string }
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description ?? response.status}`)
    return body.result
  }

  /** Send a card. Returns the new message's id. */
  async send(card: CardPayload): Promise<number> {
    const result = (await this.call('sendMessage', {
      chat_id: this.config.chatId,
      text: card.text,
      reply_markup: card.reply_markup,
    })) as { message_id: number }
    return result.message_id
  }

  /** Rewrite a card to show it expired and strip its buttons. */
  async editExpired(messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: this.config.chatId,
      message_id: messageId,
      text,
      reply_markup: { inline_keyboard: [] },
    })
  }

  /** Clear the button's spinner after handling a callback. */
  async answerCallback(callbackId: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackId })
  }

  /**
   * Fetch pending updates. Returns the owner's events and the offset to pass
   * next. Updates from any other chat are consumed (so they do not repeat) but
   * not surfaced.
   */
  async poll(offset: number): Promise<{ nextOffset: number; events: TelegramEvent[] }> {
    const updates = (await this.call('getUpdates', {
      offset,
      timeout: this.pollTimeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    })) as Update[]

    let nextOffset = offset
    const events: TelegramEvent[] = []
    for (const update of updates) {
      nextOffset = update.update_id + 1
      const callback = update.callback_query
      if (callback?.message) {
        if (String(callback.message.chat.id) !== this.config.chatId) continue
        events.push({
          kind: 'callback',
          callbackId: callback.id,
          data: callback.data,
          messageId: callback.message.message_id,
        })
        continue
      }
      const message = update.message
      if (message?.text) {
        if (String(message.chat.id) !== this.config.chatId) continue
        events.push({ kind: 'text', text: message.text })
      }
    }
    return { nextOffset, events }
  }
}
