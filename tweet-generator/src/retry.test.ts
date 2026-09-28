import { describe, expect, it } from 'vitest'
import { LlmError, LlmUnavailableError } from 'shared/llm'
import {
  FAST_RETRY_DELAYS_MS,
  fastRetryDelayMs,
  parseRetryAfterMs,
  policyForStatus,
  retryAfterMsOf,
  retryAfterMsOfError,
  retryPolicyOf,
  shouldAlert,
} from 'shared/retry'
import { AgentLensError } from './sources/agentlens.js'

describe('policyForStatus', () => {
  it('treats a 5xx as worth waiting a cycle for', () => {
    expect(policyForStatus(500)).toBe('slow')
    expect(policyForStatus(503)).toBe('slow')
  })

  it('treats a 429 as the server dictating the pace', () => {
    expect(policyForStatus(429)).toBe('quota')
  })

  it('treats every other 4xx as something waiting cannot fix', () => {
    expect(policyForStatus(400)).toBe('never')
    expect(policyForStatus(401)).toBe('never')
    expect(policyForStatus(403)).toBe('never')
    expect(policyForStatus(404)).toBe('never')
  })
})

describe('fastRetryDelayMs', () => {
  it('backs off further on each attempt', () => {
    const delays = FAST_RETRY_DELAYS_MS.map((_, i) =>
      fastRetryDelayMs('fast', i + 1),
    )
    expect(delays).toEqual([...FAST_RETRY_DELAYS_MS])
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!)
    }
  })

  it('gives up once the schedule is exhausted', () => {
    expect(fastRetryDelayMs('fast', FAST_RETRY_DELAYS_MS.length + 1)).toBeNull()
  })

  it('never retries in-cycle for the slower policies', () => {
    // 5xx and quota recover on a scale the cycle interval already covers, and
    // hammering a 429 is what gets the quota window extended.
    expect(fastRetryDelayMs('slow', 1)).toBeNull()
    expect(fastRetryDelayMs('quota', 1)).toBeNull()
    expect(fastRetryDelayMs('never', 1)).toBeNull()
  })
})

describe('shouldAlert', () => {
  it('alerts on the first failure that will never self-heal', () => {
    // A 401 is still a 401 in six hours. Sitting on it buys nothing.
    expect(shouldAlert('never', 1)).toBe(true)
  })

  it('gives a recoverable failure three cycles before alerting', () => {
    expect(shouldAlert('slow', 1)).toBe(false)
    expect(shouldAlert('slow', 2)).toBe(false)
    expect(shouldAlert('slow', 3)).toBe(true)
  })

  it('alerts once rather than on every cycle of a long outage', () => {
    expect(shouldAlert('slow', 4)).toBe(false)
    expect(shouldAlert('never', 2)).toBe(false)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads a delay given in seconds', () => {
    expect(parseRetryAfterMs('120')).toBe(120_000)
  })

  it('reads a delay given as an HTTP date', () => {
    const at = new Date(Date.now() + 90_000).toUTCString()
    const ms = parseRetryAfterMs(at)
    expect(ms).not.toBeNull()
    // Whole-second resolution in the header, so allow a second of slack.
    expect(Math.abs(ms! - 90_000)).toBeLessThan(1000)
  })

  it('ignores a date that has already passed', () => {
    expect(parseRetryAfterMs(new Date(Date.now() - 60_000).toUTCString())).toBe(
      0,
    )
  })

  it('returns null for a missing or unparseable header', () => {
    expect(parseRetryAfterMs(null)).toBeNull()
    expect(parseRetryAfterMs(undefined)).toBeNull()
    expect(parseRetryAfterMs('soon')).toBeNull()
    expect(parseRetryAfterMs('-5')).toBeNull()
  })
})

describe('retryAfterMsOf', () => {
  it('reads the header off a real response', () => {
    const response = new Response(null, {
      status: 429,
      headers: { 'retry-after': '45' },
    })
    expect(retryAfterMsOf(response)).toBe(45_000)
  })

  it('reports nothing when a response carries no header bag', () => {
    // Both clients take an injected fetch, and the stand-ins are not obliged
    // to build a real Response. Reading a header must not turn a 429 into a
    // crash inside the error path.
    expect(retryAfterMsOf({ status: 429 } as unknown as Response)).toBeNull()
  })
})

describe('retryPolicyOf', () => {
  it('reads the policy off an upstream failure', () => {
    expect(retryPolicyOf(new AgentLensError('x', { retry: 'fast' }))).toBe(
      'fast',
    )
    expect(
      retryPolicyOf(new LlmUnavailableError('x', { retry: 'never' })),
    ).toBe('never')
  })

  it('claims nothing for a reply the pipeline already handles', () => {
    // A bad reply is re-asked by the pipeline and never reaches the loop.
    // Were it to count as an upstream failure, an unparseable JSON blob
    // would be reported as an outage and burn a cycle.
    expect(retryPolicyOf(new LlmError('The LLM reply was not valid JSON'))).toBe(
      null,
    )
  })

  it('claims nothing for an ordinary bug', () => {
    expect(retryPolicyOf(new TypeError('x is not a function'))).toBeNull()
    expect(retryPolicyOf('a thrown string')).toBeNull()
    expect(retryPolicyOf(null)).toBeNull()
  })

  it('ignores a `retry` field that is not a policy', () => {
    const impostor = Object.assign(new Error('x'), { retry: 'sometimes' })
    expect(retryPolicyOf(impostor)).toBeNull()
  })
})

describe('retryAfterMsOfError', () => {
  it('reads the pace off an error that carries one', () => {
    const error = new AgentLensError('x', {
      retry: 'quota',
      retryAfterMs: 600_000,
    })
    expect(retryAfterMsOfError(error)).toBe(600_000)
  })

  it('reports nothing when the server named no pace', () => {
    expect(retryAfterMsOfError(new AgentLensError('x'))).toBeNull()
    expect(retryAfterMsOfError(new Error('x'))).toBeNull()
  })
})
