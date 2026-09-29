/**
 * The routing decision, pure. Given the rule flags and Jev's judgements, it
 * picks what happens to a message: nothing, an alert, a template reply, or an
 * LLM draft. It never waits to see whether someone else answered — that step
 * is deliberately dropped.
 *
 * Only called when the rules did not drop the message; a drop is the caller's,
 * at stage `rule`.
 */
import type { JevJudgement } from 'shared/jev'
import type { RuleFlags } from './rules.js'
import type { Thresholds } from './config.js'

export type Route = 'drop' | 'alert' | 'template' | 'draft' | 'record_only'
export type Stage = 'rule' | 'jev' | 'template' | 'llm'

export interface Decision {
  route: Route
  stage: Stage
  /** Whether a draft should first search history — set only for a draft. */
  needsHistory: boolean
}

type Judgements = Record<string, JevJudgement>

function addressedToOwner(
  flags: RuleFlags,
  jev: Judgements,
  addressedMin: number,
): boolean {
  if (flags.mentionsOwner || flags.quotesOwner) return true
  const addressed = jev.addressed
  return addressed?.label === 'true' && addressed.confidence >= addressedMin
}

export function route(
  flags: RuleFlags,
  jev: Judgements,
  thresholds: Thresholds,
): Decision {
  const intent = jev.intent
  const confident = intent.confidence >= thresholds.intentMin
  const addressed = addressedToOwner(flags, jev, thresholds.addressedMin)
  const needsHistory = jev.needs_history?.label === 'true'
  const recordOnly: Decision = { route: 'record_only', stage: 'jev', needsHistory: false }

  // A probe or a critical message is only ever surfaced, never answered by the
  // machine — this guard comes before any draft branch.
  if ((intent.label === 'ai_probe' || intent.label === 'critical') && confident) {
    return { route: 'alert', stage: 'jev', needsHistory: false }
  }

  // Being pinged and getting silence is the worst outcome, so an uncertain
  // judgement on a message aimed at the owner is surfaced rather than dropped.
  if (addressed && !confident) {
    return { route: 'alert', stage: 'jev', needsHistory: false }
  }

  if (intent.label === 'question' && confident) {
    // A question thrown at a specific other person is theirs to answer.
    if (flags.mentionsOther && !flags.mentionsOwner) return recordOnly
    return { route: 'draft', stage: 'llm', needsHistory }
  }

  if (intent.label === 'praise' && addressed && intent.confidence >= thresholds.praiseMin) {
    return { route: 'template', stage: 'template', needsHistory: false }
  }

  return recordOnly
}
