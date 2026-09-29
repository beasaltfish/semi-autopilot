/**
 * Judging one message: rules → Jev → routing → (alert / template / draft /
 * record) → a `reply_decisions` row. Pure orchestration over injected
 * dependencies, so it is tested without a network or a database. The service
 * loop (index.ts) supplies the real Jev, LLM, retrieval and store, stores the
 * row, and — within the rate limit — pushes the card.
 */
import type { JevJudgement } from 'shared/jev'
import type { LlmClient } from 'shared/llm'
import type { Rng } from 'shared/rng'
import type { Thresholds } from './config.js'
import { draftReply } from './draft.js'
import { judgementQuestions } from './questions.js'
import type { Retrieval } from './retrieval.js'
import { applyRules } from './rules.js'
import { route } from './routing.js'
import type { Candidate, NewReplyDecision } from './store.js'
import { pickTemplate } from './templates.js'

export interface JudgeDeps {
  jev: { decide(state: unknown, questions: typeof judgementQuestions): Promise<Record<string, JevJudgement>> }
  llm: Pick<LlmClient, 'chat'>
  retrieval: Pick<Retrieval, 'similarOwnerReplies' | 'expertFor'>
  /** Embed the message when its row has no embedding yet. */
  embed: (text: string) => Promise<number[]>
  recentContext: (channelId: string, before: Date, n: number) => Promise<{ authorName: string; content: string }[]>
  templatesUsedFor: (authorId: string, since: Date) => Promise<string[]>
  rng: Rng
}

export interface JudgeConfig {
  owner: { id: string; names: string[] }
  thresholds: Thresholds
  templates: string[]
  styleRules: string[]
  banned: string[]
  maxDraftChars: number
  templateCooldownMinutes: number
  contextSize: number
  expertNeighbours: number
  now: Date
}

export async function judge(
  candidate: Candidate,
  deps: JudgeDeps,
  config: JudgeConfig,
): Promise<NewReplyDecision> {
  const outcome = applyRules(candidate, config.owner)
  if ('drop' in outcome) {
    return { messageId: candidate.id, stage: 'rule', route: 'drop' }
  }
  const flags = outcome.flags

  const context = await deps.recentContext(candidate.channelId, candidate.timestamp, config.contextSize)
  const jev = await deps.jev.decide(
    { message: candidate.content, recent: context, owner_names: config.owner.names },
    judgementQuestions,
  )
  const decision = route(flags, jev, config.thresholds)

  if (decision.route === 'alert' || decision.route === 'record_only') {
    return { messageId: candidate.id, stage: decision.stage, route: decision.route, jev }
  }

  if (decision.route === 'template') {
    const since = new Date(config.now.getTime() - config.templateCooldownMinutes * 60_000)
    const used = new Set(await deps.templatesUsedFor(candidate.authorId, since))
    const template = pickTemplate(config.templates, used, deps.rng)
    // All on cooldown: don't nag with a stale line — just record.
    if (!template) return { messageId: candidate.id, stage: 'jev', route: 'record_only', jev }
    return { messageId: candidate.id, stage: 'template', route: 'template', jev, draft: template }
  }

  // decision.route === 'draft'
  const embedding = candidate.embedding ?? (await deps.embed(candidate.content))
  const fewShot = await deps.retrieval.similarOwnerReplies(embedding, config.owner.id, 3)
  // The expert @ is only for a question that needs history; a self-contained
  // one the owner just answers. An expert emerges only when someone recurs.
  const expert = decision.needsHistory
    ? await deps.retrieval.expertFor(embedding, candidate.channelId, [config.owner.id, candidate.authorId], config.expertNeighbours)
    : null

  const result = await draftReply(
    deps.llm,
    {
      message: candidate.content,
      context,
      retrieved: [],
      mentionName: expert?.authorName ?? null,
      styleRules: config.styleRules,
      fewShot,
    },
    { maxChars: config.maxDraftChars, banned: config.banned },
  )

  return {
    messageId: candidate.id,
    stage: 'llm',
    route: 'draft',
    jev,
    draft: 'text' in result ? result.text : null,
    mentionAuthorId: expert?.authorId ?? null,
  }
}
