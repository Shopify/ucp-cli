// mcp-client.ts unit tests.
//
// The stubbed fetch is both transport spy and response source: each test pins
// what JSON-RPC request we send and how the narrow MCP adapter maps the
// response or failure into UCP errors.

import { describe, expect, it, vi } from 'vitest'

import { mcpRpc } from './mcp-client.js'

const ENDPOINT = 'https://shop.example.invalid/ucp/mcp'

interface CapturedRequest {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function recorder(response: Response): { fetch: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = []
  const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return response
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

describe('mcpRpc — wire format', () => {
  it('POSTs a JSON-RPC 2.0 envelope and returns the result field', async () => {
    const { fetch, calls } = recorder(
      jsonResponse({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
    )

    const result = await mcpRpc<{ tools: unknown[] }>({
      endpoint: ENDPOINT,
      method: 'tools/list',
      fetch,
      id: 1,
    })

    expect(result).toEqual({ tools: [] })
    expect(calls).toHaveLength(1)
    const [captured] = calls
    if (captured === undefined) throw new Error('unreachable')
    expect(captured.url).toBe(ENDPOINT)
    expect(captured.init.method).toBe('POST')
    const body = JSON.parse(captured.init.body as string) as Record<string, unknown>
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  })

  it('forwards params verbatim and merges caller-supplied headers', async () => {
    const { fetch, calls } = recorder(jsonResponse({ jsonrpc: '2.0', id: 'x', result: 'ok' }))

    await mcpRpc({
      endpoint: ENDPOINT,
      method: 'tools/call',
      params: { name: 'search_catalog', arguments: { query: 'hat' } },
      headers: { 'Trace-Id': 'abc123' },
      fetch,
      id: 'x',
    })

    const [captured] = calls
    if (captured === undefined) throw new Error('unreachable')
    const headers = new Headers(captured.init.headers as Record<string, string>)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('trace-id')).toBe('abc123')

    const body = JSON.parse(captured.init.body as string) as { params: unknown }
    expect(body.params).toEqual({ name: 'search_catalog', arguments: { query: 'hat' } })
  })

  it('omits the `params` member when not supplied (JSON-RPC §4.2)', async () => {
    const { fetch, calls } = recorder(jsonResponse({ jsonrpc: '2.0', id: 1, result: null }))
    await mcpRpc({ endpoint: ENDPOINT, method: 'ping', fetch, id: 1 })
    const [captured] = calls
    if (captured === undefined) throw new Error('unreachable')
    const body = JSON.parse(captured.init.body as string) as Record<string, unknown>
    expect('params' in body).toBe(false)
  })
})

describe('mcpRpc — error mapping', () => {
  it('throws MCP_RPC_ERROR with rpcCode/rpcData when the server returns a JSON-RPC error', async () => {
    const { fetch } = recorder(
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'method not found', data: { method: 'nope' } },
      }),
    )

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'nope', fetch, id: 1 })).rejects.toThrowError(
      expect.objectContaining({
        code: 'MCP_RPC_ERROR',
        layer: 'transport',
        context: expect.objectContaining({ rpcCode: -32601, rpcData: { method: 'nope' } }),
      }) as unknown as Error,
    )
  })

  it('throws SERVICE_UNAVAILABLE on HTTP 503 (spec-aligned, retryable)', async () => {
    const { fetch } = recorder(new Response('boom', { status: 503 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'SERVICE_UNAVAILABLE',
        layer: 'transport',
        http_status: 503,
        retryable: true,
      }) as unknown as Error,
    )
  })

  it('throws AUTH_REQUIRED on HTTP 401 with handoff CTA', async () => {
    const { fetch } = recorder(new Response('unauthorized', { status: 401 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'AUTH_REQUIRED',
        layer: 'transport',
        http_status: 401,
        retryable: false,
        cta: expect.objectContaining({
          description: expect.stringContaining('continue_url'),
        }),
      }) as unknown as Error,
    )
  })

  it('throws INSUFFICIENT_PERMISSIONS on HTTP 403 with handoff CTA', async () => {
    const { fetch } = recorder(new Response('forbidden', { status: 403 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'INSUFFICIENT_PERMISSIONS',
        layer: 'transport',
        http_status: 403,
        retryable: false,
        cta: expect.objectContaining({
          description: expect.stringContaining('continue_url'),
        }),
      }) as unknown as Error,
    )
  })

  it('throws RATE_LIMITED on HTTP 429 (retryable)', async () => {
    const { fetch } = recorder(new Response('slow down', { status: 429 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'RATE_LIMITED',
        layer: 'transport',
        http_status: 429,
        retryable: true,
      }) as unknown as Error,
    )
  })

  it('throws IDEMPOTENCY_CONFLICT on HTTP 409', async () => {
    const { fetch } = recorder(new Response('conflict', { status: 409 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'IDEMPOTENCY_CONFLICT',
        layer: 'transport',
        http_status: 409,
        retryable: false,
      }) as unknown as Error,
    )
  })

  it('throws BUSINESS_SERVER_ERROR on HTTP 500 (retryable)', async () => {
    const { fetch } = recorder(new Response('boom', { status: 500 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'BUSINESS_SERVER_ERROR',
        layer: 'transport',
        http_status: 500,
        retryable: true,
      }) as unknown as Error,
    )
  })

  it('falls back to TRANSPORT_HTTP_ERROR for unmapped 4xx (e.g. 418)', async () => {
    const { fetch } = recorder(new Response('teapot', { status: 418 }))

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'TRANSPORT_HTTP_ERROR',
        layer: 'transport',
        http_status: 418,
        retryable: false,
      }) as unknown as Error,
    )
  })

  it('JSON-RPC error path: HTTP 401 promotes to AUTH_REQUIRED (not MCP_RPC_ERROR)', async () => {
    const { fetch } = recorder(
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'AuthenticationRequired' },
        },
        { status: 401 },
      ),
    )

    await expect(
      mcpRpc({ endpoint: ENDPOINT, method: 'tools/call', fetch, id: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'AUTH_REQUIRED',
        http_status: 401,
        message: expect.stringContaining('AuthenticationRequired'),
      }) as unknown as Error,
    )
  })

  it('JSON-RPC error path: unmapped HTTP status keeps MCP_RPC_ERROR', async () => {
    // 422 is not in the spec's protocol-error table; preserve the more
    // specific MCP_RPC_ERROR rather than fall through to TRANSPORT_HTTP_ERROR.
    const { fetch } = recorder(
      jsonResponse(
        { jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'invalid input' } },
        { status: 422 },
      ),
    )

    await expect(
      mcpRpc({ endpoint: ENDPOINT, method: 'tools/call', fetch, id: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'MCP_RPC_ERROR', http_status: 422 }) as unknown as Error,
    )
  })

  it('surfaces JSON-RPC error details even when HTTP status is non-2xx', async () => {
    const { fetch } = recorder(
      jsonResponse(
        {
          jsonrpc: '2.0',
          id: 1,
          error: {
            code: -32001,
            message: 'UCP discovery failed',
            data: {
              code: 'invalid_profile_url',
              content: 'Unable to fetch agent profile: Missing profile uri',
            },
          },
        },
        { status: 422 },
      ),
    )

    await expect(
      mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch, id: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: 'MCP_RPC_ERROR',
        layer: 'transport',
        http_status: 422,
        message: expect.stringContaining(
          'invalid_profile_url: Unable to fetch agent profile: Missing profile uri',
        ),
        context: expect.objectContaining({
          http_status: 422,
          rpcCode: -32001,
          rpcData: expect.objectContaining({ code: 'invalid_profile_url' }),
        }),
      }) as unknown as Error,
    )
  })

  it('throws TRANSPORT_INVALID_JSON when the body is not parseable', async () => {
    const { fetch } = recorder(
      new Response('not json', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({ code: 'TRANSPORT_INVALID_JSON' }) as unknown as Error,
    )
  })

  it('throws MCP_INVALID_RESPONSE when the envelope is missing both result and error', async () => {
    const { fetch } = recorder(jsonResponse({ jsonrpc: '2.0', id: 1 }))
    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({ code: 'MCP_INVALID_RESPONSE' }) as unknown as Error,
    )
  })

  it('throws MCP_INVALID_RESPONSE when response id does not match request id', async () => {
    const { fetch } = recorder(jsonResponse({ jsonrpc: '2.0', id: 999, result: { ok: true } }))
    await expect(
      mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch, id: 1 }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'MCP_INVALID_RESPONSE' }) as unknown as Error,
    )
  })

  it('throws TRANSPORT_NETWORK_ERROR when fetch itself rejects', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    await expect(mcpRpc({ endpoint: ENDPOINT, method: 'tools/list', fetch })).rejects.toThrowError(
      expect.objectContaining({
        code: 'TRANSPORT_NETWORK_ERROR',
        layer: 'transport',
      }) as unknown as Error,
    )
  })

  it('throws INVALID_INPUT when endpoint is not https', async () => {
    await expect(
      mcpRpc({ endpoint: 'http://shop.example.invalid/ucp/mcp', method: 'tools/list' }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', layer: 'client' }) as unknown as Error,
    )
  })
})
