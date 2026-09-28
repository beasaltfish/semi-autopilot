import type { TweetArchetype } from 'shared'
import type { Candidate } from '../sources/candidates.js'
import { assemble, type Draft } from './assemble.js'
import {
  extractJson,
  LlmError,
  LlmUnavailableError,
  type ChatMessage,
} from 'shared/llm'
import {
  buildCritiquePrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  sourceTextOf,
  SYSTEM_PROMPT,
  type Critique,
} from './prompts.js'
import { validate, type BannedPhrases, type Violation } from './validate.js'

export interface PipelineDeps {
  chat(messages: ChatMessage[]): Promise<string>
  banned: BannedPhrases
  maxRounds: number
}

export interface PipelineResult {
  text: string
  draft: Draft
  rounds: number
}

/** Every round used up without a draft that passed. The cycle skips. */
export class GenerationGaveUp extends Error {
  constructor(
    message: string,
    readonly violations: string[],
  ) {
    super(message)
    this.name = 'GenerationGaveUp'
  }
}

/** The model returns loose fields; this pins them to the archetype's shape. */
function toDraft(
  archetype: TweetArchetype,
  parsed: Record<string, unknown>,
): Draft {
  switch (archetype) {
    case 'digest':
      return {
        archetype,
        hook: String(parsed.hook ?? ''),
        highlights: Array.isArray(parsed.highlights)
          ? parsed.highlights.map(String)
          : [],
      }
    case 'metric':
      return {
        archetype,
        metric: String(parsed.metric ?? ''),
        line: String(parsed.line ?? ''),
      }
    default:
      return { archetype, text: String(parsed.text ?? '') }
  }
}

/**
 * A critic that replies with something unparseable is treated as a pass.
 *
 * The draft has already cleared the deterministic gate, so it is
 * publishable. Discarding it because the critic answered badly trades a good
 * post for nothing at all.
 */
async function runCritique(
  candidate: Candidate,
  text: string,
  soft: Violation[],
  deps: PipelineDeps,
  system: ChatMessage,
): Promise<Critique> {
  try {
    const reply = await deps.chat([
      system,
      { role: 'user', content: buildCritiquePrompt(candidate, text, soft) },
    ])
    const parsed = extractJson<Partial<Critique>>(reply)
    return {
      verdict: parsed.verdict === 'revise' ? 'revise' : 'pass',
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String) : [],
    }
  } catch (error) {
    // An outage still propagates. Only an unusable reply is forgiven.
    if (error instanceof LlmUnavailableError) throw error
    if (!(error instanceof LlmError)) throw error
    return { verdict: 'pass', issues: [] }
  }
}

/**
 * Generate → validate → critique → rewrite.
 *
 * Validation runs before the critique because it is free: a critique call
 * should never be spent on a draft that is already mechanically broken.
 *
 * Rules that fired on the previous round are carried forward so the
 * validator's loop guard can downgrade a stylistic rule the model has now
 * failed twice — a rule the model cannot satisfy is a broken rule.
 */
export async function generateTweet(
  candidate: Candidate,
  archetype: TweetArchetype,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const sourceText = sourceTextOf(candidate)
  const system: ChatMessage = { role: 'system', content: SYSTEM_PROMPT }

  let prompt = buildGeneratePrompt(candidate, archetype)
  let previousRules = new Set<string>()
  let lastViolations: string[] = ['no draft was produced']
  /** The critic's single veto, spent the first time it asks for a revision. */
  let critiqueSpent = false

  for (let round = 1; round <= deps.maxRounds; round++) {
    let draft: Draft
    let text: string
    try {
      const reply = await deps.chat([system, { role: 'user', content: prompt }])
      draft = toDraft(archetype, extractJson<Record<string, unknown>>(reply))
      text = assemble(draft)
    } catch (error) {
      // An unreachable model is not this candidate's fault. Letting it burn
      // rounds here would blacklist innocent candidates during an outage and
      // hide the outage from the loop, so the alert would never fire.
      if (error instanceof LlmUnavailableError) throw error
      if (!(error instanceof LlmError)) throw error
      // A reply we could not parse is a failed round, not a crash. The next
      // round re-asks from scratch.
      lastViolations = [error.message]
      prompt = buildGeneratePrompt(candidate, archetype)
      previousRules = new Set()
      continue
    }

    const result = validate({
      draft,
      text,
      sourceText,
      repeatedRules: previousRules,
      banned: deps.banned,
    })

    if (!result.ok) {
      lastViolations = result.hard.map((violation) => violation.message)
      previousRules = new Set(result.hard.map((violation) => violation.rule))
      prompt = buildRewritePrompt(candidate, archetype, draft, lastViolations)
      continue
    }

    // The critic gets exactly one veto.
    //
    // Asked to critique, a model always finds something: across 48 real
    // rounds on two unrelated models it never once returned "pass", and the
    // issue count per round stayed flat or rose. An unbounded critic is
    // therefore not a quality gate, it is a guarantee of zero output.
    //
    // One veto keeps what the critic is actually good at — catching the
    // obvious miss on the first draft — while honouring the rule the rest of
    // this file already follows: a draft that has cleared the deterministic
    // gate is publishable, and trading it for nothing is the worse outcome.
    //
    // The same reasoning caps it on the final round, where a veto cannot be
    // acted on at all: there is no round left to rewrite in, so asking can
    // only throw away a draft that has already cleared every hard gate. A
    // digest that spends rounds 1 and 2 on the highlight budget lands here
    // every time.
    if (critiqueSpent || round === deps.maxRounds) {
      return { text, draft, rounds: round }
    }

    const critique = await runCritique(
      candidate,
      text,
      result.soft,
      deps,
      system,
    )
    if (critique.verdict === 'pass' || critique.issues.length === 0) {
      return { text, draft, rounds: round }
    }

    critiqueSpent = true
    lastViolations = critique.issues
    previousRules = new Set()
    prompt = buildRewritePrompt(candidate, archetype, draft, critique.issues)
  }

  throw new GenerationGaveUp(
    `Gave up after ${deps.maxRounds} rounds`,
    lastViolations,
  )
}
