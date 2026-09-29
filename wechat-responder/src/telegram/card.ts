/**
 * The Telegram cards, built as plain data (no network here). A draft card
 * shows the message, Jev's judgements and the proposed reply, with 👍/👎/✏️;
 * an alert card shows an ai_probe or critical message with a single "知道了".
 * Callbacks are encoded compactly, because Telegram caps callback_data at 64
 * bytes.
 */
import type { JevJudgement } from 'shared/jev'

export interface CardPayload {
  text: string
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] }
}

export type CallbackAction = 'approve' | 'reject' | 'edit' | 'ack'

export interface Callback {
  action: CallbackAction
  decisionId: number
}

const ACTION_CODE: Record<CallbackAction, string> = {
  approve: 'a',
  reject: 'r',
  edit: 'e',
  ack: 'k',
}
const CODE_ACTION = Object.fromEntries(
  Object.entries(ACTION_CODE).map(([action, code]) => [code, action]),
) as Record<string, CallbackAction>

export function encodeCallback(cb: Callback): string {
  return `${ACTION_CODE[cb.action]}:${cb.decisionId}`
}

export function parseCallback(data: string): Callback | null {
  const match = /^([arek]):(\d+)$/.exec(data)
  if (!match) return null
  return { action: CODE_ACTION[match[1]], decisionId: Number(match[2]) }
}

/** One line summarising Jev's judgements, e.g. "question 0.91 · 找我 是". */
function judgementLine(jev: Record<string, JevJudgement>): string {
  const parts: string[] = []
  if (jev.intent) parts.push(`${jev.intent.label} ${jev.intent.confidence.toFixed(2)}`)
  if (jev.addressed) parts.push(`找我 ${jev.addressed.label === 'true' ? '是' : '否'}`)
  return parts.join(' · ')
}

function button(text: string, cb: Callback): { text: string; callback_data: string } {
  return { text, callback_data: encodeCallback(cb) }
}

export function draftCard(d: {
  decisionId: number
  group: string
  sender: string
  message: string
  jev: Record<string, JevJudgement>
  mentionName: string | null
  draft: string | null
}): CardPayload {
  const lines = [
    `💬 ${d.group} · ${d.sender}`,
    `原文：${d.message}`,
    `判断：${judgementLine(d.jev)}`,
  ]
  if (d.mentionName) lines.push(`建议 @${d.mentionName}`)
  lines.push('', d.draft ? `草稿：${d.draft}` : '（没有草稿，需要你来写）')

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          button('👍', { action: 'approve', decisionId: d.decisionId }),
          button('👎', { action: 'reject', decisionId: d.decisionId }),
          button('✏️', { action: 'edit', decisionId: d.decisionId }),
        ],
      ],
    },
  }
}

export function alertCard(d: {
  decisionId: number
  group: string
  sender: string
  message: string
  reason: 'ai_probe' | 'critical'
  jev: Record<string, JevJudgement>
}): CardPayload {
  const heading = d.reason === 'ai_probe' ? '🕵️ 疑似在试探是不是机器人' : '⚠️ 需要留意'
  return {
    text: [
      heading,
      `${d.group} · ${d.sender}`,
      `原文：${d.message}`,
      `判断：${judgementLine(d.jev)}`,
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[button('知道了', { action: 'ack', decisionId: d.decisionId })]],
    },
  }
}
