// ucpFetch: the single outbound HTTP path. Mirrors the layering rules
// documented in src/core/http-client.ts.

import { describe, expect, it } from 'vitest'

import { ucpFetch } from './http-client.js'

function captureFetch(): {
  fetch: typeof fetch
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetch: fakeFetch, calls }
}

describe('ucpFetch', () => {
  it('seeds the built-in User-Agent at lowest priority', async () => {
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' })
    const headers = new Headers(calls[0]?.init.headers as Record<string, string>)
    expect(headers.get('user-agent')).toMatch(/^@shopify\/ucp-cli\//)
  })

  it('caller-supplied User-Agent overrides the built-in', async () => {
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', {
      fetch,
      traceLabel: 'test',
      headers: { 'User-Agent': 'my-agent/1.0' },
    })
    const headers = new Headers(calls[0]?.init.headers as Record<string, string>)
    expect(headers.get('user-agent')).toBe('my-agent/1.0')
  })

  it('framing wins over caller headers (dispatcher-owned)', async () => {
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', {
      fetch,
      traceLabel: 'test',
      headers: { 'Content-Type': 'text/plain' },
      framing: { 'Content-Type': 'application/json' },
    })
    const headers = new Headers(calls[0]?.init.headers as Record<string, string>)
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('caller headers ship alongside framing when names do not conflict', async () => {
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', {
      fetch,
      traceLabel: 'test',
      headers: { Authorization: 'Bearer abc', 'Trace-Id': 'req-1' },
      framing: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })
    const headers = new Headers(calls[0]?.init.headers as Record<string, string>)
    expect(headers.get('authorization')).toBe('Bearer abc')
    expect(headers.get('trace-id')).toBe('req-1')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
  })

  it('forwards method, body, and signal verbatim', async () => {
    const { fetch, calls } = captureFetch()
    const ac = new AbortController()
    await ucpFetch('https://example.com/rpc', {
      fetch,
      traceLabel: 'test',
      method: 'POST',
      body: '{"id":1}',
      signal: ac.signal,
    })
    expect(calls[0]?.url).toBe('https://example.com/rpc')
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.body).toBe('{"id":1}')
    expect(calls[0]?.init.signal).toBe(ac.signal)
  })

  it('omits method/body/signal entirely when undefined (matches fetch() defaults)', async () => {
    // exactOptionalPropertyTypes: present-as-undefined and absent are different.
    // We pass nothing through unless the caller set it.
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' })
    const init = calls[0]?.init ?? {}
    expect('method' in init).toBe(false)
    expect('body' in init).toBe(false)
    expect('signal' in init).toBe(false)
  })
})
