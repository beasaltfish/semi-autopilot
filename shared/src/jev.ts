/**
 * Client for Jev, TypeSafe AI's decision model, reached through OpenRouter's
 * `/api/alpha/decisions` endpoint. Jev is a classifier, not a generator: it
 * takes a `state` and a map of named, typed questions, and returns one typed
 * answer per question with a confidence. That is exactly the judgement the
 * WeChat responder needs — intent, whether it is addressed to the owner, and
 * whether history is needed — in a single call, far cheaper than an LLM.
 *
 * The wire format follows OpenRouter's Decisions API reference. HTTP is faked
 * through an injected `fetch` in tests, the pattern the workspace already uses.
 */
import { policyForStatus, retryAfterMsOf, type RetryPolicy } from './retry.js'
import type { JevJudgement } from './schema.js'

export type { JevJudgement }

/** Where Jev is and which model to pin. */
export interface JevConfig {
  /** The full decisions endpoint, e.g. https://openrouter.ai/api/alpha/decisions */
  url: string
  apiKey: string
  /** The OpenRouter model id, e.g. `typesafe/jev-1.13` or `~typesafe/jev-latest`. */
  model: string
  timeoutMs: number
}

/**
 * A question to put to Jev. `noul` is yes/no, `choice` picks one named option,
 * `score` rates against an ordered rubric. `instructions` says what to judge;
 * `criteria` says what each answer means.
 */
export type JevQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

/** Jev replied, but with something unusable — a missing or malformed answer. */
export class JevError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JevError'
  }
}

/** The request did not get a usable HTTP reply. Carries how retrying may help. */
export class JevUnavailableError extends JevError {
  readonly retry: RetryPolicy
  readonly retryAfterMs: number | null

  constructor(
    message: string,
    options: { retry: RetryPolicy; retryAfterMs?: number | null; cause?: unknown },
  ) {
    super(message, { cause: options.cause })
    this.name = 'JevUnavailableError'
    this.retry = options.retry
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

interface NoulAnswer {
  type: 'noul'
  noul: number
}
interface ChoiceAnswer {
  type: 'choice'
  choice: string
  confidence: number
  probabilities?: Record<string, number>
}
interface ScoreAnswer {
  type: 'score'
  score: number
  confidence: number
}
type JevAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer

interface DecisionsResponse {
  answers?: Record<string, JevAnswer>
}

/** Reduce one typed answer to the `{ label, confidence }` the schema stores. */
function toJudgement(
  id: string,
  question: JevQuestion,
  answer: JevAnswer | undefined,
): JevJudgement {
  if (!answer || answer.type !== question.type) {
    throw new JevError(`Jev gave no ${question.type} answer for "${id}"`)
  }
  switch (answer.type) {
    case 'noul': {
      if (typeof answer.noul !== 'number') {
        throw new JevError(`Jev's noul answer for "${id}" had no probability`)
      }
      // noul is the probability of `true`. The label is the side that won and
      // the confidence is that side's probability, so a confident "false"
      // reads as high confidence, not low.
      const isTrue = answer.noul >= 0.5
      return { label: String(isTrue), confidence: isTrue ? answer.noul : 1 - answer.noul }
    }
    case 'choice': {
      if (typeof answer.choice !== 'string' || typeof answer.confidence !== 'number') {
        throw new JevError(`Jev's choice answer for "${id}" was malformed`)
      }
      return { label: answer.choice, confidence: answer.confidence }
    }
    case 'score': {
      if (typeof answer.score !== 'number' || typeof answer.confidence !== 'number') {
        throw new JevError(`Jev's score answer for "${id}" was malformed`)
      }
      // The rubric levels are 0..n; the nearest level names the label.
      return { label: String(Math.round(answer.score)), confidence: answer.confidence }
    }
  }
}

export class JevClient {
  constructor(
    private readonly config: JevConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Put a batch of questions about one state to Jev, returning a judgement per
   * question. One call answers all of them, which is the whole point of using
   * Jev over an LLM here.
   */
  async decide(
    state: unknown,
    questions: Record<string, JevQuestion>,
  ): Promise<Record<string, JevJudgement>> {
    const body = (await this.post({
      model: this.config.model,
      state,
      questions,
    })) as DecisionsResponse

    const judgements: Record<string, JevJudgement> = {}
    for (const [id, question] of Object.entries(questions)) {
      judgements[id] = toJudgement(id, question, body.answers?.[id])
    }
    return judgements
  }

  private async post(payload: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      })
    } catch (cause) {
      // Nothing answered — a refused connection or our own timeout; both clear
      // on a scale far shorter than a poll.
      throw new JevUnavailableError('The Jev request failed', {
        cause,
        retry: 'fast',
      })
    }

    if (!response.ok) {
      throw new JevUnavailableError(`Jev returned ${response.status}`, {
        retry: policyForStatus(response.status),
        retryAfterMs: retryAfterMsOf(response),
      })
    }

    return response.json()
  }
}
