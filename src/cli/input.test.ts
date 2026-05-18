// Operation input builder tests.
//
// CLI parser tests cover flag spelling; this suite pins the JSON assembly rules
// shared by operation commands.

import { describe, expect, it, vi } from 'vitest'

import { buildOperationInput } from './input.js'

describe('buildOperationInput', () => {
  it('starts with an empty object when no input flags are supplied', async () => {
    await expect(buildOperationInput()).resolves.toEqual({})
  })

  it('parses a JSON object literal as the base input', async () => {
    await expect(buildOperationInput({ json: '{"catalog":{"query":"boots"}}' })).resolves.toEqual({
      catalog: { query: 'boots' },
    })
  })

  it('reads JSON from @file and stdin sources', async () => {
    const readFile = vi.fn(async () => '{"catalog":{"query":"file"}}')
    const readStdin = vi.fn(async () => '{"catalog":{"query":"stdin"}}')

    await expect(buildOperationInput({ json: '@request.json', readFile })).resolves.toEqual({
      catalog: { query: 'file' },
    })
    await expect(buildOperationInput({ json: '-', readStdin })).resolves.toEqual({
      catalog: { query: 'stdin' },
    })
    expect(readFile).toHaveBeenCalledWith('request.json')
  })

  it('applies typed --set overlays in order', async () => {
    await expect(
      buildOperationInput({
        set: [
          '/catalog/query=boots',
          '/catalog/pagination/limit=2',
          '/catalog/filters/available=true',
          '/catalog/filters/tags=["winter","sale"]',
          '/catalog/context/intent=null',
        ],
      }),
    ).resolves.toEqual({
      catalog: {
        query: 'boots',
        pagination: { limit: 2 },
        filters: { available: true, tags: ['winter', 'sale'] },
        context: { intent: null },
      },
    })
  })

  it('applies --set-string after --set', async () => {
    await expect(
      buildOperationInput({
        set: ['/catalog/pagination/limit=2'],
        setString: ['/catalog/pagination/limit=02'],
      }),
    ).resolves.toEqual({ catalog: { pagination: { limit: '02' } } })
  })

  it('preserves reverse-domain keys as literal segments', async () => {
    await expect(
      buildOperationInput({
        set: ['/signals/dev.ucp.buyer_ip=192.0.2.1'],
      }),
    ).resolves.toEqual({ signals: { 'dev.ucp.buyer_ip': '192.0.2.1' } })
  })

  it('decodes ~0 and ~1 RFC 6901 escapes', async () => {
    await expect(
      buildOperationInput({
        set: ['/path~1with~1slash=ok', '/key~0with~0tilde=ok'],
      }),
    ).resolves.toEqual({ 'path/with/slash': 'ok', 'key~with~tilde': 'ok' })
  })

  it('accepts paths with or without leading slash (slash is RFC 6901 ceremony)', async () => {
    // Both forms normalize to the same JSON Pointer; users should not have to
    // know about RFC 6901 to set a value.
    await expect(buildOperationInput({ set: ['catalog/query=boots'] })).resolves.toEqual({
      catalog: { query: 'boots' },
    })
    await expect(buildOperationInput({ set: ['/catalog/query=boots'] })).resolves.toEqual({
      catalog: { query: 'boots' },
    })
  })

  it('throws INVALID_INPUT on malformed sources and paths', async () => {
    await expect(buildOperationInput({ json: '[]' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      layer: 'client',
    })
    await expect(buildOperationInput({ set: ['/catalog//query=boots'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      layer: 'client',
    })
    await expect(
      buildOperationInput({ set: ['/catalog=boots', '/catalog/query=boots'] }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      layer: 'client',
    })
  })

  // Array auto-create: numeric segment after a missing parent creates an
  // array (not an object). Walking into existing arrays via numeric index
  // works on read AND write. The append token `-` is honored as the final
  // segment when the cursor is an array.
  it('auto-creates an array when the next segment looks like an array index', async () => {
    await expect(
      buildOperationInput({
        set: [
          '/line_items/0/item/id=gid://shopify/ProductVariant/123',
          '/line_items/0/quantity=1',
          '/context/address_country=US',
        ],
      }),
    ).resolves.toEqual({
      line_items: [{ item: { id: 'gid://shopify/ProductVariant/123' }, quantity: 1 }],
      context: { address_country: 'US' },
    })
  })

  it('walks into existing arrays via numeric index for subsequent --set ops', async () => {
    await expect(
      buildOperationInput({
        json: '{"line_items":[{"item":{"id":"v1"},"quantity":1}]}',
        set: ['/line_items/0/quantity=5'],
      }),
    ).resolves.toEqual({
      line_items: [{ item: { id: 'v1' }, quantity: 5 }],
    })
  })

  it('appends to an array via the `-` final segment (RFC 6902 add semantics)', async () => {
    await expect(
      buildOperationInput({
        json: '{"line_items":[{"item":{"id":"v1"},"quantity":1}]}',
        set: ['/line_items/-={"item":{"id":"v2"},"quantity":2}'],
      }),
    ).resolves.toEqual({
      line_items: [
        { item: { id: 'v1' }, quantity: 1 },
        { item: { id: 'v2' }, quantity: 2 },
      ],
    })
  })

  it('rejects `-` as an intermediate segment (only valid as final per RFC 6902)', async () => {
    await expect(buildOperationInput({ set: ['/line_items/-/quantity=1'] })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining("'-' as an intermediate segment"),
    })
  })

  it('rejects leading-zero array indices (RFC 6901 §4)', async () => {
    await expect(
      buildOperationInput({
        json: '{"line_items":[]}',
        set: ['/line_items/01/quantity=1'],
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: expect.stringContaining('not a valid array index'),
    })
  })
})
