/**
 * The LLM's only job here is to phrase the reply the pipeline has already
 * decided to make — in the owner's voice, briefly, with no AI throat-clearing.
 * Everything else (whether to reply, to whom, with what history) is decided
 * before this. The draft is validated for length and for tell-tale AI phrases;
 * a failure buys one regeneration, then the card goes out without a draft.
 */
import type { ChatMessage, LlmClient } from 'shared/llm'

export interface DraftInput {
  /** The message being replied to. */
  message: string
  /** The last few messages in the group, oldest first. */
  context: { authorName: string; content: string }[]
  /** Retrieved history relevant to the question. */
  retrieved: string[]
  /** The display name to @, or null to answer directly. */
  mentionName: string | null
  /** The owner's hard "never" style rules. */
  styleRules: string[]
  /** A few of the owner's own similar past replies, as voice samples. */
  fewShot: string[]
}

export function buildPrompt(input: DraftInput): ChatMessage[] {
  const rules = input.styleRules.map((rule) => `- ${rule}`).join('\n')
  const system =
    '你在替我起草微信群里的回复。用我的口吻：简短、口语、真诚，通常是回答问题或鼓励别人。' +
    '不要像客服或 AI，不要套话，不要自我介绍。只输出这一条回复本身，不要解释。' +
    (rules ? `\n\n必须遵守：\n${rules}` : '')

  const parts: string[] = []
  if (input.context.length) {
    parts.push(
      '群里最近的对话：\n' +
        input.context.map((m) => `${m.authorName}：${m.content}`).join('\n'),
    )
  }
  if (input.fewShot.length) {
    parts.push('我以前类似情况的回复（模仿这个口吻）：\n' + input.fewShot.map((r) => `- ${r}`).join('\n'))
  }
  if (input.retrieved.length) {
    parts.push('可能相关的历史讨论：\n' + input.retrieved.map((r) => `- ${r}`).join('\n'))
  }
  parts.push(`需要回复的消息：\n${input.message}`)
  parts.push(
    input.mentionName
      ? `这个问题比较专业，群里 @${input.mentionName} 答过类似的。请起草一句话，自然地把问题转给 @${input.mentionName}。`
      : '请起草我的回复。',
  )

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

export function validate(
  reply: string,
  opts: { maxChars: number; banned: string[] },
): { ok: true } | { ok: false; reason: string } {
  const text = reply.trim()
  if (text.length === 0) return { ok: false, reason: 'empty' }
  if (text.length > opts.maxChars) return { ok: false, reason: 'too long' }
  const hit = opts.banned.find((phrase) => text.includes(phrase))
  if (hit) return { ok: false, reason: `banned phrase: ${hit}` }
  return { ok: true }
}

/**
 * Draft a reply, regenerating once if the first fails validation. A second
 * failure returns `{ failed: true }`, and the caller pushes a draft-less card
 * rather than a bad one.
 */
export async function draftReply(
  llm: Pick<LlmClient, 'chat'>,
  input: DraftInput,
  opts: { maxChars: number; banned: string[] },
): Promise<{ text: string } | { failed: true }> {
  const prompt = buildPrompt(input)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const reply = (await llm.chat(prompt)).trim()
    if (validate(reply, opts).ok) return { text: reply }
  }
  return { failed: true }
}
