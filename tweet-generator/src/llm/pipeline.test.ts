import { describe, expect, it, vi } from 'vitest'
import type { Candidate } from '../sources/candidates.js'
import { LlmError, LlmUnavailableError } from 'shared/llm'
import { DEFAULT_BANNED_PHRASES } from './validate.js'
import {
  generateTweet,
  GenerationGaveUp,
  type PipelineDeps,
} from './pipeline.js'

const candidate: Candidate = {
  kind: 'gh_project',
  externalId: 'ghp:a/b',
  title: 'a/b',
  summary: 'A gateway with 290 providers.',
  body: 'One endpoint for 290 providers and 500 models.',
  facts: ['a/b', '18.4k stars', '+443 stars/day', 'MIT'],
  sourceUrl: 'https://github.com/a/b',
  freshness: new Date('2026-08-05T02:00:00.000Z'),
  dedupeKey: 'agentlens:project:ghp:a/b:stars-10k',
  entities: [],
}

const goodDraft = JSON.stringify({
  hook: 'One endpoint, 290 providers.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
})

const badNumberDraft = JSON.stringify({
  hook: 'It cuts cost by 93%.',
  highlights: ['18.4k stars', '+443 stars/day', 'MIT'],
})

const pass = JSON.stringify({ verdict: 'pass', issues: [] })
const revise = JSON.stringify({
  verdict: 'revise',
  issues: ['the hook does not say what it replaces'],
})

function deps(chat: (messages: unknown) => Promise<string>): PipelineDeps {
  return {
    chat: chat as PipelineDeps['chat'],
    banned: DEFAULT_BANNED_PHRASES,
    maxRounds: 3,
  }
}

describe('generateTweet', () => {
  it('returns on the first round when the draft validates and passes critique', async () => {
    const chat = vi.fn().mockResolvedValueOnce(goodDraft).mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(1)
    expect(result.text).toContain('One endpoint, 290 providers.')
    expect(result.text).toContain('→ 18.4k stars')
    expect(chat).toHaveBeenCalledTimes(2)
  })

  it('does not spend a critique call on a draft that fails validation', async () => {
    // The deterministic gate runs first because it is free.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'digest', deps(chat))

    // Three calls: generate, rewrite, critique. Never a critique on round 1.
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('rewrites against critique issues and returns the fixed draft', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(2)
    const rewritePrompt = JSON.stringify(chat.mock.calls[2]![0])
    expect(rewritePrompt).toContain('the hook does not say what it replaces')
  })

  it('gives the rewrite everything a fresh call needs to answer', async () => {
    // A chat call carries no history, so a rewrite that only names the issues
    // leaves the model guessing at the schema. It guesses wrong, the draft
    // parses to empty fields, and every candidate needing a second round is
    // lost. The prompt has to restate the shape and the material.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'digest', deps(chat))

    const rewritePrompt = JSON.stringify(chat.mock.calls[2]![0])
    expect(rewritePrompt).toContain('highlights')
    expect(rewritePrompt).toContain('290 providers and 500 models')
    expect(rewritePrompt).toContain('One endpoint, 290 providers.')
  })

  it('rewrites a validation failure against the same full brief', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'digest', deps(chat))

    const rewritePrompt = JSON.stringify(chat.mock.calls[1]![0])
    expect(rewritePrompt).toContain('highlights')
    expect(rewritePrompt).toContain('290 providers and 500 models')
    expect(rewritePrompt).toContain('93%')
  })

  it('ships a revised draft that clears validation without re-consulting the critic', async () => {
    // Asked to critique, a model always finds something — across 48 real
    // rounds on two unrelated models the critic never once returned "pass".
    // One veto is what keeps it a quality gate rather than a zero-output
    // guarantee.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(goodDraft)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(2)
    // Generate, critique, rewrite. No fourth call: the veto was spent.
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('still enforces every hard rule after the critic has been overruled', async () => {
    // Only the critic is capped. The deterministic gate is not: a rewrite
    // that invents a number must not ship just because the veto is spent.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(revise)
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(goodDraft)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(3)
    expect(result.text).not.toContain('93%')
  })

  it('does not spend a veto on the final round, where it cannot be acted on', async () => {
    // A digest that burns rounds 1 and 2 on the highlight budget reaches a
    // clean draft only on the last round. Asking the critic there can only
    // discard it — there is no round left to rewrite in.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(badNumberDraft)
      .mockResolvedValueOnce(goodDraft)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.rounds).toBe(3)
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('gives up after maxRounds and reports what was still wrong', async () => {
    const chat = vi.fn().mockResolvedValue(badNumberDraft)

    await expect(generateTweet(candidate, 'digest', deps(chat))).rejects.toThrow(
      GenerationGaveUp,
    )

    try {
      await generateTweet(candidate, 'digest', deps(chat))
    } catch (error) {
      expect((error as GenerationGaveUp).violations.join(' ')).toContain('93%')
    }
  })

  it("feeds the previous round's rules forward so the loop guard can fire", async () => {
    // Round 1 fails on "buckle up"; round 2 sees it repeat and downgrades it,
    // so the post ships rather than being lost to an unsatisfiable rule.
    const cliche = JSON.stringify({ text: 'Buckle up, 290 providers.' })
    const chat = vi
      .fn()
      .mockResolvedValueOnce(cliche)
      .mockResolvedValueOnce(cliche)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'take', deps(chat))

    expect(result.rounds).toBe(2)
    expect(result.text).toContain('Buckle up')
  })

  it('passes soft flags to the critique prompt', async () => {
    const soft = JSON.stringify({
      text: 'Failover is seamless across 290 providers.',
    })
    const chat = vi.fn().mockResolvedValueOnce(soft).mockResolvedValueOnce(pass)

    await generateTweet(candidate, 'take', deps(chat))

    const critiquePrompt = JSON.stringify(chat.mock.calls[1]![0])
    expect(critiquePrompt).toContain('seamless')
  })

  it('treats an unparseable reply as a failed round rather than a crash', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce('I cannot help with that.')
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))
    expect(result.rounds).toBe(2)
  })

  it('treats an unparseable critique as a pass rather than losing the draft', async () => {
    // The draft already cleared the deterministic gate. Discarding it
    // because the critic replied badly trades a good post for nothing.
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce('looks fine to me!')

    const result = await generateTweet(candidate, 'digest', deps(chat))
    expect(result.rounds).toBe(1)
  })

  it('propagates an outage instead of blaming the candidate', async () => {
    // An unreachable model is not this candidate's fault. Burning its three
    // rounds here would blacklist an innocent candidate for an
    // infrastructure problem, and hide the outage from the service loop so
    // the alert never fires.
    const chat = vi
      .fn()
      .mockRejectedValue(new LlmUnavailableError('connection refused'))

    await expect(generateTweet(candidate, 'digest', deps(chat))).rejects.toThrow(
      LlmUnavailableError,
    )
    // One attempt, not three: it gave up as soon as it knew.
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('propagates an outage that strikes during the critique', async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(goodDraft)
      .mockRejectedValueOnce(new LlmUnavailableError('connection refused'))

    await expect(generateTweet(candidate, 'digest', deps(chat))).rejects.toThrow(
      LlmUnavailableError,
    )
  })

  it('still forgives an unusable reply from a reachable model', async () => {
    // The distinction that matters: reachable-but-useless costs a round,
    // unreachable costs nothing and stops immediately.
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('The LLM returned no content'))
      .mockResolvedValueOnce(goodDraft)
      .mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))
    expect(result.rounds).toBe(2)
  })

  it('returns the draft alongside the text, for the card renderer', async () => {
    const chat = vi.fn().mockResolvedValueOnce(goodDraft).mockResolvedValueOnce(pass)

    const result = await generateTweet(candidate, 'digest', deps(chat))

    expect(result.draft.archetype).toBe('digest')
    expect(result.draft).toHaveProperty('hook')
  })
})
