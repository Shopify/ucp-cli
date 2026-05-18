import { afterEach, describe, expect, it, vi } from 'vitest'

import { parseHttpsUrl } from './url.js'

describe('parseHttpsUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts https URLs by default', () => {
    expect(parseHttpsUrl('https://shop.example.com/path', 'business URL').toString()).toBe(
      'https://shop.example.com/path',
    )
  })

  it('rejects http loopback unless the test-only bypass is enabled', () => {
    expect(() => parseHttpsUrl('http://127.0.0.1:3000/mcp', 'business URL')).toThrow(
      /must use https/,
    )
  })

  it('allows http loopback with UCP_TEST_ALLOW_INSECURE_LOCALHOST=true', () => {
    vi.stubEnv('UCP_TEST_ALLOW_INSECURE_LOCALHOST', 'true')
    expect(parseHttpsUrl('http://localhost:3000/mcp', 'business URL').toString()).toBe(
      'http://localhost:3000/mcp',
    )
  })

  it('still rejects remote http URLs when the test-only bypass is enabled', () => {
    vi.stubEnv('UCP_TEST_ALLOW_INSECURE_LOCALHOST', 'true')
    expect(() => parseHttpsUrl('http://shop.example.com/mcp', 'business URL')).toThrow(
      /must use https/,
    )
  })

  it('canonicalizes bare hostnames to https://', () => {
    expect(parseHttpsUrl('shop.example.com', 'business URL').toString()).toBe(
      'https://shop.example.com/',
    )
    expect(parseHttpsUrl('jlabgrabbag.myshopify.com', 'business URL').toString()).toBe(
      'https://jlabgrabbag.myshopify.com/',
    )
  })

  it('canonicalizes bare hostnames with port suffix', () => {
    expect(parseHttpsUrl('shop.example.com:8443', 'business URL').toString()).toBe(
      'https://shop.example.com:8443/',
    )
  })

  it('does NOT canonicalize loopback (needs explicit scheme)', () => {
    expect(() => parseHttpsUrl('localhost', 'business URL')).toThrow(/is not a valid URL/)
    // Loopback test escape hatch still requires an explicit http:// scheme.
    vi.stubEnv('UCP_TEST_ALLOW_INSECURE_LOCALHOST', 'true')
    expect(() => parseHttpsUrl('localhost:3000', 'business URL')).toThrow()
  })

  it('does NOT canonicalize path-shaped or weird input', () => {
    expect(() => parseHttpsUrl('shop.com/path', 'business URL')).toThrow(/is not a valid URL/)
    expect(() => parseHttpsUrl('user@shop.com', 'business URL')).toThrow(/is not a valid URL/)
    expect(() => parseHttpsUrl('not a domain', 'business URL')).toThrow(/is not a valid URL/)
  })
})
