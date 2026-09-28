import { describe, expect, it, vi } from 'vitest'
import { extractJson, LlmClient, LlmError, type LlmConfig } from './llm.js'

const config: LlmConfig = {
  baseUrl: 'http://localhost:20128/v1',
  apiKey: null,
  model: 'pinned-model',
  timeoutMs: 5000,
}

function stubChat(content: string, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  })
}

describe('LlmClient.chat', () => {
  it('posts to /chat/completions with the pinned model', async () => {
    const fetchImpl = stubChat('hello')
    const client = new LlmClient(config, fetchImpl as never)

    const reply = await client.chat([{ role: 'user', content: 'hi' }])

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('http://localhost:20128/v1/chat/completions')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('pinned-model')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.stream).toBe(false)
    expect(reply).toBe('hello')
  })

  it('does not send response_format', async () => {
    // OmniRoute's lower provider tiers ignore it, so depending on it would
    // break on exactly the days the router falls back.
    const fetchImpl = stubChat('hello')
    await new LlmClient(config, fetchImpl as never).chat([
      { role: 'user', content: 'hi' },
    ])

    const body = JSON.parse(
      (fetchImpl.mock.calls[0]![1] as RequestInit).body as string,
    )
    expect(body).not.toHaveProperty('response_format')
  })

  it('omits the Authorization header when no key is configured', async () => {
    const fetchImpl = stubChat('hello')
    await new LlmClient(config, fetchImpl as never).chat([
      { role: 'user', content: 'hi' },
    ])

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect(init.headers).not.toHaveProperty('Authorization')
  })

  it('sends the key when one is configured', async () => {
    const fetchImpl = stubChat('hello')
    await new LlmClient(
      { ...config, apiKey: 'sk-test' },
      fetchImpl as never,
    ).chat([{ role: 'user', content: 'hi' }])

    const init = fetchImpl.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-test',
    )
  })

  it('tolerates a base URL with a trailing slash', async () => {
    const fetchImpl = stubChat('hello')
    await new LlmClient(
      { ...config, baseUrl: 'http://localhost:20128/v1/' },
      fetchImpl as never,
    ).chat([{ role: 'user', content: 'hi' }])

    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'http://localhost:20128/v1/chat/completions',
    )
  })

  it('throws LlmError on a non-200', async () => {
    const client = new LlmClient(config, stubChat('', 503) as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })

  it('throws LlmError when the response has no content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }),
    })
    const client = new LlmClient(config, fetchImpl as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })

  it('throws LlmError when the transport fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new LlmClient(config, fetchImpl as never)
    await expect(client.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      LlmError,
    )
  })

  it('marks a transport failure as worth retrying immediately', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new LlmClient(config, fetchImpl as never)
    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ retry: 'fast' })
  })

  it('marks a 5xx as the router’s problem to fix', async () => {
    const client = new LlmClient(config, stubChat('', 503) as never)
    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ retry: 'slow' })
  })

  it('marks a rejected key as something retrying will never fix', async () => {
    // A dead LLM_API_KEY currently costs six hours before anyone is told.
    const client = new LlmClient(config, stubChat('', 401) as never)
    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ retry: 'never' })
  })

  it('carries the router’s own pace off a 429', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '30' }),
      json: async () => ({}),
    })
    const client = new LlmClient(config, fetchImpl as never)
    await expect(
      client.chat([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ retry: 'quota', retryAfterMs: 30_000 })
  })
})

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('strips a fenced code block', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('ignores prose before and after', () => {
    // Weaker models narrate. The object is still in there.
    expect(extractJson('Sure! Here is the draft:\n{"a":1}\nLet me know.')).toEqual(
      { a: 1 },
    )
  })

  it('handles braces inside strings', () => {
    expect(extractJson('{"a":"a } b"}')).toEqual({ a: 'a } b' })
  })

  it('handles an escaped quote inside a string', () => {
    expect(extractJson('{"a":"say \\" now"}')).toEqual({ a: 'say " now' })
  })

  it('handles nested objects', () => {
    expect(extractJson('noise {"a":{"b":[1,2]}} noise')).toEqual({
      a: { b: [1, 2] },
    })
  })

  it('throws LlmError when there is no object at all', () => {
    expect(() => extractJson('I cannot help with that.')).toThrow(LlmError)
  })

  it('throws LlmError when the object never closes', () => {
    expect(() => extractJson('{"a":1')).toThrow(LlmError)
  })

  it('throws LlmError on a malformed object rather than returning junk', () => {
    expect(() => extractJson('{"a": undefined}')).toThrow(LlmError)
  })
})
