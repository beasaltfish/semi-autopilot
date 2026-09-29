import { describe, expect, it, vi } from 'vitest'
import { JevClient, JevError, JevUnavailableError, type JevQuestion } from './jev.js'

const config = {
  url: 'https://openrouter.ai/api/alpha/decisions',
  apiKey: 'test-key',
  model: 'typesafe/jev-1.13',
  timeoutMs: 30_000,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
}

const intent: JevQuestion = {
  type: 'choice',
  instructions: 'What is the intent?',
  criteria: { question: 'asks something', praise: 'compliments', chitchat: 'small talk' },
}
const addressed: JevQuestion = {
  type: 'noul',
  instructions: 'Is it addressed to the owner?',
  criteria: { true: 'to the owner', false: 'to someone else' },
}

describe('JevClient.decide', () => {
  it('sends the state, model and questions with a bearer token', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ answers: { intent: { type: 'choice', choice: 'question', confidence: 0.9 } } }),
    )
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await client.decide('作业交了吗', { intent })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(config.url)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'typesafe/jev-1.13',
      state: '作业交了吗',
      questions: { intent },
    })
  })

  it('maps a choice answer to its label and confidence', async () => {
    const fetchImpl = async () =>
      jsonResponse({
        answers: {
          intent: {
            type: 'choice',
            choice: 'question',
            confidence: 0.84,
            probabilities: { question: 0.84, praise: 0.16, chitchat: 0 },
          },
        },
      })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    const result = await client.decide('s', { intent })
    expect(result.intent).toEqual({ label: 'question', confidence: 0.84 })
  })

  it('maps a noul answer to the winning side and its probability', async () => {
    const fetchImpl = async () =>
      jsonResponse({ answers: { addressed: { type: 'noul', noul: 0.2 } } })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    const result = await client.decide('s', { addressed })
    // 0.2 chance of true → the answer is "false", held with 0.8 confidence.
    expect(result.addressed).toEqual({ label: 'false', confidence: 0.8 })
  })

  it('answers several questions in one call', async () => {
    const fetchImpl = async () =>
      jsonResponse({
        answers: {
          intent: { type: 'choice', choice: 'praise', confidence: 0.7 },
          addressed: { type: 'noul', noul: 0.95 },
        },
      })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    const result = await client.decide('s', { intent, addressed })
    expect(result.intent.label).toBe('praise')
    expect(result.addressed).toEqual({ label: 'true', confidence: 0.95 })
  })

  it('throws when a question has no answer', async () => {
    const fetchImpl = async () => jsonResponse({ answers: {} })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await expect(client.decide('s', { intent })).rejects.toThrow(JevError)
  })

  it('throws when the answer type does not match the question', async () => {
    const fetchImpl = async () =>
      jsonResponse({ answers: { intent: { type: 'noul', noul: 0.5 } } })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await expect(client.decide('s', { intent })).rejects.toThrow(JevError)
  })

  it('treats a 5xx as a slow-retryable outage', async () => {
    const fetchImpl = async () => jsonResponse({}, { status: 503 })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await expect(client.decide('s', { intent })).rejects.toMatchObject({
      name: 'JevUnavailableError',
      retry: 'slow',
    })
  })

  it('treats a 401 as never-retryable', async () => {
    const fetchImpl = async () => jsonResponse({}, { status: 401 })
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await expect(client.decide('s', { intent })).rejects.toMatchObject({ retry: 'never' })
  })

  it('treats a transport failure as fast-retryable', async () => {
    const fetchImpl = async () => {
      throw new Error('connection refused')
    }
    const client = new JevClient(config, fetchImpl as unknown as typeof fetch)
    await expect(client.decide('s', { intent })).rejects.toMatchObject({
      name: 'JevUnavailableError',
      retry: 'fast',
    })
    expect(JevUnavailableError).toBeDefined()
  })
})
