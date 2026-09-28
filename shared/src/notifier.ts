/**
 * Notifications, to Discord or Telegram.
 *
 * Discord was the only channel while every service was a background job the
 * owner checked on occasionally. The WeChat assistant's owner lives in
 * Telegram, where its drafts already go, so a second channel is now warranted.
 * Each service picks one in its own config; nothing here chooses for it.
 *
 * `service` is a parameter rather than a constant because more than one
 * service reports through here, and a notification that does not say
 * which process stopped is a notification you have to go and investigate.
 */
export type NotifyTarget =
  | { kind: 'discord'; webhookUrl: string }
  | { kind: 'telegram'; botToken: string; chatId: string }

/** Telegram refuses a message longer than this outright. */
const TELEGRAM_MAX_LENGTH = 4096

/**
 * The target a service's environment names, or null for none.
 *
 * Telegram needs both halves; a token without a chat id falls through to
 * Discord rather than failing on the first alert.
 */
export function loadNotifyTarget(
  env: NodeJS.ProcessEnv = process.env,
): NotifyTarget | null {
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    return {
      kind: 'telegram',
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    }
  }
  if (env.DISCORD_WEBHOOK_URL) {
    return { kind: 'discord', webhookUrl: env.DISCORD_WEBHOOK_URL }
  }
  return null
}

/** A bare string is a Discord webhook, which is what every caller passed before. */
function normalise(target: NotifyTarget | string | null): NotifyTarget | null {
  if (!target) return null
  if (typeof target === 'string') return { kind: 'discord', webhookUrl: target }
  return target
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

async function send(
  rawTarget: NotifyTarget | string | null,
  service: string,
  emoji: string,
  headline: string,
  message: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const target = normalise(rawTarget)
  if (!target) return

  try {
    if (target.kind === 'discord') {
      await fetchImpl(target.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: service,
          content: `${emoji} **${headline}**\n\`\`\`\n${message}\n\`\`\``,
        }),
      })
      return
    }

    // Plain text, no parse_mode: MarkdownV2 rejects any unescaped `.` or
    // `-`, and an error message is full of both.
    await fetchImpl(
      `https://api.telegram.org/bot${target.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: truncate(
            `${emoji} ${headline}\n\n${message}`,
            TELEGRAM_MAX_LENGTH,
          ),
        }),
      },
    )
  } catch {
    // A broken notification must not mask the failure it was reporting.
  }
}

/** The process has stopped and will not start again on its own. */
export function notifyFailure(
  target: NotifyTarget | string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(target, service, '🛑', `${service} stopped`, message, fetchImpl)
}

/**
 * The process is still running but is blocked on something only a person can
 * do, and will carry on by itself once they have done it.
 *
 * Worth its own headline rather than reusing `notifyFailure`: "stopped" would
 * be a lie, and a notification that misstates whether the service is alive
 * costs someone a trip to the machine to find out.
 */
export function notifyAttention(
  target: NotifyTarget | string | null,
  service: string,
  message: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  return send(
    target,
    service,
    '⏸️',
    `${service} is waiting for you`,
    message,
    fetchImpl,
  )
}
