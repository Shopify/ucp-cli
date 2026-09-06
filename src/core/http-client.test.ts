// ucpFetch: the single outbound HTTP path. Mirrors the layering rules
// documented in src/core/http-client.ts.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'

import { ErrorCodes } from '../lib/errors.js'
import { refusedRedirect, ucpFetch, usableRedirectTarget } from './http-client.js'

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

// Refused everywhere, on two authorities: UCP requires the documents an
// exchange dereferences to be served without redirects, and ucp-cli applies
// the same rule to a negotiated service endpoint, whose identity the profile
// already declares. One seam, so one statement of the rule.
describe('ucpFetch — redirects', () => {
  it("asks fetch for redirect: 'manual' on every request", async () => {
    const { fetch, calls } = captureFetch()
    await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' })
    expect(calls[0]?.init.redirect).toBe('manual')
  })

  it.each([301, 302, 303, 307, 308])('refuses HTTP %i and names the Location', async (status) => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, {
        status,
        headers: { location: 'https://elsewhere.example/profile.json' },
      })
    await expect(
      ucpFetch('https://example.com/profile.json', { fetch, traceLabel: 'test' }),
    ).rejects.toMatchObject({
      code: ErrorCodes.TRANSPORT_REDIRECT_REFUSED,
      layer: 'transport',
      http_status: status,
      message: expect.stringContaining('https://elsewhere.example/profile.json'),
    })
  })

  it('exposes the refused hop structurally, so callers need not read the message', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 308, headers: { location: 'https://www.example.com/x' } })
    const err = await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' }).catch(
      (e: unknown) => e,
    )
    expect(refusedRedirect(err)).toEqual({ status: 308, location: 'https://www.example.com/x' })
    expect(refusedRedirect(new Error('boom'))).toBeUndefined()
  })

  it('offers only the serve-it-here remedy when the refused response has no Location', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 302 })
    const err = await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' }).catch(
      (e: unknown) => e,
    )
    expect(refusedRedirect(err)).toEqual({ status: 302, location: null })
    expect((err as Error).message).toContain(
      'Serve the requested resource at https://example.com/x itself',
    )
    expect((err as Error).message).toContain('named no target')
  })

  // One message serves both a spec violation and a house rule, so it must not
  // present the second as the first: the quoted MUST NOT covers dereferenced
  // documents, and nothing in it reaches a negotiated operation endpoint.
  it('attributes the rule to UCP for documents and to ucp-cli for endpoints', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/mcp' } })
    const err = await ucpFetch('https://shop.example/mcp', { fetch, traceLabel: 'test' }).catch(
      (e: unknown) => e,
    )
    const message = (err as Error).message
    expect(message).toContain('UCP forbids redirects on the documents an exchange dereferences')
    expect(message).toContain('ucp-cli additionally refuses them on a negotiated service endpoint')
    // The endpoint clause rests on the declared endpoint, so it reads the
    // same for a same-origin https→https hop.
    expect(message).toContain('neither declared nor validated')
  })

  // The remedy points at whatever declared the refused URL, because ucpFetch
  // does not know which one that was — an enumeration here would be wrong for
  // a service operation resource and would omit `schema` / `supported_versions`.
  it('names the declaration that supplied the URL, not a list of fields', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 308, headers: { location: '/v2/ucp' } })
    const err = await ucpFetch('https://shop.example/.well-known/ucp', {
      fetch,
      traceLabel: 'test',
    }).catch((e: unknown) => e)
    const message = (err as Error).message
    expect(message).toContain('the declaration that supplied https://shop.example/.well-known/ucp')
    expect(message).toContain('https://shop.example/v2/ucp')
    expect(message).not.toContain('meta.profile_url')
  })

  // UCP URLs are https, so an http target can never be the remedy.
  it('refuses to offer an http target as the fix', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { location: 'http://example.com/x' } })
    const err = await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' }).catch(
      (e: unknown) => e,
    )
    const message = (err as Error).message
    // Named as the fact the origin reported, and the remedy sends the operator
    // back to https rather than to that target. That the target is unusable at
    // all is `usableRedirectTarget`'s case below, not this one's.
    expect(message).toContain('`Location: http://example.com/x`')
    expect(message).toContain('over https')
  })

  it.each([
    ['https://example.com/x', '/v2/profile.json', 'https://example.com/v2/profile.json'],
    ['https://example.com/x', 'https://cdn.example.com/p.json', 'https://cdn.example.com/p.json'],
    ['https://example.com/x', 'http://example.com/x', null],
    ['https://example.com/x', 'https://[', null],
    ['https://example.com/x', null, null],
  ])('usableRedirectTarget(%s, %s) → %s', (url, location, expected) => {
    // A relative Location is legal, so the remedy resolves it before deciding
    // whether it is an https URL worth naming.
    expect(usableRedirectTarget(url, location)).toBe(expected)
  })

  // A refused 3xx still carries a body, and undici keeps the connection busy
  // until that body is read or cancelled. Nothing here will ever read it, so
  // ucpFetch releases it; the cancel below rejects to prove the release cannot
  // displace the refusal the caller is waiting for.
  it('cancels the body of the response it refuses, and still throws the refusal', async () => {
    let cancelled = 0
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('<html>moved</html>')),
          cancel: () => {
            cancelled += 1
            throw new Error('cancel exploded')
          },
        }),
        { status: 302, headers: { location: 'https://elsewhere.example/x' } },
      )
    const err = await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' }).catch(
      (e: unknown) => e,
    )
    expect(cancelled).toBe(1)
    expect(refusedRedirect(err)).toEqual({ status: 302, location: 'https://elsewhere.example/x' })
  })

  it('passes 304 through — a conditional answer is not a hop', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 304 })
    const response = await ucpFetch('https://example.com/x', { fetch, traceLabel: 'test' })
    expect(response.status).toBe(304)
  })

  // The assertions above pin the argument we pass to `fetch`; this one pins
  // the wire. Real sockets, real undici: refusing means the target of the
  // `Location` is never requested at all, so the target server's log must be
  // empty. Asserting on that log rather than on `response.url` is what makes
  // this a statement about requests issued.
  it('never issues the second request (real loopback sockets)', async () => {
    const received: string[] = []
    const target = await listen(
      createServer((req, res) => {
        received.push(`${req.method} ${req.url} x-api-key=${req.headers['x-api-key']}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      }),
    )
    // Nested, so a failure to start or run the second server still closes the
    // first: a listener left open would hold the port and the process open.
    try {
      const origin = await listen(
        createServer((_req, res) => {
          res.writeHead(302, { location: `${target.url}/profile.json` })
          res.end()
        }),
      )
      try {
        const err = await ucpFetch(`${origin.url}/profile.json`, {
          headers: { 'X-Api-Key': 'secret' },
          traceLabel: 'test',
        }).catch((e: unknown) => e)
        expect(refusedRedirect(err)?.location).toBe(`${target.url}/profile.json`)
        expect(received).toEqual([])
      } finally {
        await origin.close()
      }
    } finally {
      await target.close()
    }
  })
})

async function listen(server: Server): Promise<{ url: string; close: () => Promise<void> }> {
  // Rejects on a bind failure instead of hanging until the test times out; the
  // caller's finally then has nothing to close, which is the truth.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
