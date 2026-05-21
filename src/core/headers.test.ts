// Header resolver: four-source merge, validation, redaction.
//
// Mirrors the structure of escalation.test.ts: resolveX → run/parse → support
// utilities. Tests exercise the public API; internals (the bag, interpolation,
// the regexes) are covered indirectly through resolveHeaders / parseHeaderFlag.
//
// Test fixtures intentionally avoid the `X-` prefix (deprecated by RFC 6648).
// Custom test names use suffix-style (`Trace-Id`, `Tenant-Id`, etc.); sensitive
// suffix detection (`-Key`, `-Token`, `-Secret`, `-Password`) is exercised by
// names that match those patterns regardless of prefix.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  canonicalizeOrigin,
  defaultUserAgent,
  formatHeadersForTrace,
  isReservedHeader,
  isSensitiveHeaderName,
  parseHeaderFlag,
  redactHeadersForLog,
  resolveHeaders,
} from './headers.js'

// Two distinct origins so per-origin selection and merge ordering can be
// exercised. Both under IANA-reserved example.com (RFC 2606) so docs and
// fixtures stay vendor-neutral.
const ORIGIN = 'https://shop.example.com'
const OTHER_ORIGIN = 'https://other.example.com'

async function writeHeadersFile(homeDir: string, profile: string, body: unknown): Promise<void> {
  const dir = join(homeDir, 'profiles', profile)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'headers.json'), JSON.stringify(body), 'utf-8')
}

describe('defaultUserAgent', () => {
  it('returns "@shopify/ucp-cli/<semver>"', () => {
    expect(defaultUserAgent()).toMatch(/^@shopify\/ucp-cli\/\d+\.\d+\.\d+/)
  })
})

describe('parseHeaderFlag', () => {
  it('splits on the FIRST colon so values may contain colons', () => {
    expect(parseHeaderFlag('Trace-Id: req:abc:123')).toEqual({
      name: 'Trace-Id',
      value: 'req:abc:123',
    })
  })

  it('trims whitespace around name and value but preserves embedded whitespace', () => {
    expect(parseHeaderFlag('  Authorization :  Bearer eyJ.abc  ')).toEqual({
      name: 'Authorization',
      value: 'Bearer eyJ.abc',
    })
  })

  it('accepts no-space form "Name:Value"', () => {
    expect(parseHeaderFlag('Api-Key:abc123')).toEqual({ name: 'Api-Key', value: 'abc123' })
  })

  it('rejects input without a colon', () => {
    expect(() => parseHeaderFlag('No-Colon-Here')).toThrow(/expected "Name: Value"/)
  })

  it('rejects empty header name', () => {
    expect(() => parseHeaderFlag(': only-value')).toThrow(/header name cannot be empty/)
  })

  it('rejects header names with non-RFC-7230 token chars', () => {
    expect(() => parseHeaderFlag('Foo Bar: baz')).toThrow(/invalid header name/)
    expect(() => parseHeaderFlag('Foo(comment): bar')).toThrow(/invalid header name/)
    expect(() => parseHeaderFlag('Foo@At: bar')).toThrow(/invalid header name/)
  })

  it('rejects header values with CR or LF (injection guard)', () => {
    expect(() => parseHeaderFlag('Trace-Id: a\nb')).toThrow(/CR or LF/)
    expect(() => parseHeaderFlag('Trace-Id: a\rb')).toThrow(/CR or LF/)
  })
})

describe('isReservedHeader', () => {
  it.each([
    ['Content-Type'],
    ['content-type'],
    ['CONTENT-TYPE'],
    ['Accept'],
    ['Host'],
    ['Connection'],
    ['Keep-Alive'],
    ['Transfer-Encoding'],
    ['TE'],
    ['Upgrade'],
    ['Proxy-Connection'],
    ['MCP-Protocol-Version'],
  ])('reserved: %s', (name) => {
    expect(isReservedHeader(name)).toBe(true)
  })

  it.each([
    ['User-Agent'],
    ['Authorization'],
    ['Api-Key'],
    ['Cookie'],
    ['Custom-Anything'],
  ])('not reserved: %s', (name) => {
    expect(isReservedHeader(name)).toBe(false)
  })
})

describe('isSensitiveHeaderName', () => {
  it.each([
    'Authorization',
    'authorization',
    'AUTHORIZATION',
    'Cookie',
    'Proxy-Authorization',
    'Api-Key',
    'API-KEY',
    'Access-Token',
    'Client-Secret',
    'User-Password',
  ])('sensitive: %s', (name) => {
    expect(isSensitiveHeaderName(name)).toBe(true)
  })

  it.each([
    'User-Agent',
    'Accept',
    'Trace-Id',
    'Tenant-Id',
    'Region',
  ])('not sensitive: %s', (name) => {
    expect(isSensitiveHeaderName(name)).toBe(false)
  })
})

describe('redactHeadersForLog', () => {
  it('replaces sensitive header values with <redacted>, leaves names intact', () => {
    const redacted = redactHeadersForLog({
      'User-Agent': '@shopify/ucp-cli/1.0.0',
      Authorization: 'Bearer eyJ.SHOULD.NOT.LEAK',
      'Api-Key': 'sk_live_SHOULD_NOT_LEAK',
      'Trace-Id': 'req-abc',
    })
    expect(redacted).toEqual({
      'User-Agent': '@shopify/ucp-cli/1.0.0',
      Authorization: '<redacted>',
      'Api-Key': '<redacted>',
      'Trace-Id': 'req-abc',
    })
  })

  it('produces no string in any value that contains a real token substring', () => {
    const redacted = redactHeadersForLog({
      Authorization: 'Bearer top-secret-token-12345',
      'Api-Key': 'sk_test_SUPER_SECRET',
    })
    const dump = JSON.stringify(redacted)
    expect(dump).not.toContain('top-secret-token-12345')
    expect(dump).not.toContain('SUPER_SECRET')
  })
})

describe('formatHeadersForTrace', () => {
  it('renders names + values with sensitive values redacted, sorted by name', () => {
    const line = formatHeadersForTrace({
      'Trace-Id': 'abc',
      Authorization: 'Bearer SHOULD-NOT-LEAK',
      'User-Agent': '@shopify/ucp-cli/0.5.0',
      'Api-Key': 'sk_test_SHOULD-NOT-LEAK',
    })
    expect(line).toBe(
      'Api-Key: <redacted>, Authorization: <redacted>, Trace-Id: abc, User-Agent: @shopify/ucp-cli/0.5.0',
    )
    expect(line).not.toContain('SHOULD-NOT-LEAK')
  })

  it('renders <none> for the empty bag', () => {
    expect(formatHeadersForTrace({})).toBe('<none>')
  })
})

describe('canonicalizeOrigin', () => {
  it('strips path / query / hash', () => {
    expect(canonicalizeOrigin('https://shop.example.com/foo?bar#baz')).toBe(
      'https://shop.example.com',
    )
  })

  it('preserves non-default ports', () => {
    expect(canonicalizeOrigin('https://shop.example.com:8443/x')).toBe(
      'https://shop.example.com:8443',
    )
  })

  it('returns undefined for unparseable input', () => {
    expect(canonicalizeOrigin('not a url')).toBeUndefined()
    expect(canonicalizeOrigin('')).toBeUndefined()
  })
})

describe('resolveHeaders — built-in', () => {
  it('seeds User-Agent at the lowest priority', async () => {
    const result = await resolveHeaders({ env: {}, origin: ORIGIN })
    expect(result['User-Agent']).toMatch(/^@shopify\/ucp-cli\//)
  })

  it('built-in User-Agent is overridable by every other source', async () => {
    // Flag wins over business wins over default wins over built-in.
    const homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-headers-test-'))
    try {
      await writeHeadersFile(homeDir, 'eval', {
        default: { 'User-Agent': 'from-default' },
        businesses: { [ORIGIN]: { 'User-Agent': 'from-business' } },
      })
      const result = await resolveHeaders({
        env: {},
        homeDir,
        profile: 'eval',
        origin: ORIGIN,
        argFlags: ['User-Agent: from-flag'],
      })
      expect(result['User-Agent']).toBe('from-flag')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('resolveHeaders — --header flag', () => {
  it('values land on the wire verbatim', async () => {
    const result = await resolveHeaders({
      env: {},
      origin: ORIGIN,
      argFlags: ['Trace-Id: abc-123', 'Tenant-Id: acme'],
    })
    expect(result).toMatchObject({ 'Trace-Id': 'abc-123', 'Tenant-Id': 'acme' })
  })

  it('multiple flags compose (no conflict, no order surprise)', async () => {
    const result = await resolveHeaders({
      env: {},
      origin: ORIGIN,
      argFlags: ['Authorization: Bearer eyJ.abc', 'Tenant-Id: acme'],
    })
    expect(result).toMatchObject({
      Authorization: 'Bearer eyJ.abc',
      'Tenant-Id': 'acme',
    })
  })

  it('repeated --header with same name keeps last-set value (highest-priority within flag source)', async () => {
    const result = await resolveHeaders({
      env: {},
      origin: ORIGIN,
      argFlags: ['Trace-Id: first', 'Trace-Id: last'],
    })
    expect(result['Trace-Id']).toBe('last')
  })

  it('silently drops reserved framing headers', async () => {
    const result = await resolveHeaders({
      env: {},
      origin: ORIGIN,
      argFlags: ['Content-Type: text/plain', 'Host: attacker.example.com', 'Trace-Id: ok'],
    })
    expect(result['Content-Type']).toBeUndefined()
    expect(result.Host).toBeUndefined()
    expect(result['Trace-Id']).toBe('ok')
  })

  it('empty value clears any lower-priority value for that header', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-headers-test-'))
    try {
      await writeHeadersFile(homeDir, 'eval', {
        default: { Authorization: 'Bearer from-config' },
      })
      const result = await resolveHeaders({
        env: {},
        homeDir,
        profile: 'eval',
        origin: ORIGIN,
        argFlags: ['Authorization:'],
      })
      expect(result.Authorization).toBeUndefined()
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('resolveHeaders — config source', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-headers-test-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('default headers apply to every origin', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { 'Trace-Id': 'global' },
    })
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(result['Trace-Id']).toBe('global')
    const other = await resolveHeaders({
      env: {},
      homeDir,
      profile: 'eval',
      origin: OTHER_ORIGIN,
    })
    expect(other['Trace-Id']).toBe('global')
  })

  it('businesses[<origin>] adds and overrides default', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { 'Trace-Id': 'global', Foo: 'global-foo' },
      businesses: { [ORIGIN]: { 'Trace-Id': 'shopify-only', Bar: 'shopify-bar' } },
    })
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(result).toMatchObject({
      'Trace-Id': 'shopify-only',
      Foo: 'global-foo',
      Bar: 'shopify-bar',
    })
  })

  it('env-var interpolation in config values substitutes from process env', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      businesses: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} is the interpolation syntax under test
        [ORIGIN]: { Authorization: 'Bearer ${SHOPIFY_TOKEN}' },
      },
    })
    const result = await resolveHeaders({
      env: { SHOPIFY_TOKEN: 'token-from-env' },
      homeDir,
      profile: 'eval',
      origin: ORIGIN,
    })
    expect(result.Authorization).toBe('Bearer token-from-env')
  })

  it('unset env-var in config substitutes to empty (which unsets the header for that scope)', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { 'Trace-Id': 'default-value' },
      businesses: {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} is the interpolation syntax under test
        [ORIGIN]: { 'Trace-Id': '${UNSET_VAR_XYZ}' },
      },
    })
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    // Empty per-origin value unsets the default for this origin.
    expect(result['Trace-Id']).toBeUndefined()
  })

  it('empty-string value at config level unsets a lower default for the same scope', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { 'User-Agent': '' },
    })
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(result['User-Agent']).toBeUndefined()
  })

  it('reserved headers in config are silently dropped', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: {
        'Content-Type': 'text/plain',
        Host: 'attacker.example.com',
        'Ok-Marker': 'kept',
      },
    })
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(result['Content-Type']).toBeUndefined()
    expect(result.Host).toBeUndefined()
    expect(result['Ok-Marker']).toBe('kept')
  })

  it('missing headers.json file is not an error (no-config path)', async () => {
    const result = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(result).toMatchObject({})
    expect(result['User-Agent']).toMatch(/^@shopify\/ucp-cli\//)
  })

  it('throws INVALID_INPUT when headers.json is not valid JSON', async () => {
    const dir = join(homeDir, 'profiles', 'eval')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'headers.json'), '{not json', 'utf-8')
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/not valid JSON/)
  })

  it('throws INVALID_INPUT when top-level is not an object', async () => {
    await writeHeadersFile(homeDir, 'eval', ['default', 'oops'])
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/must be a JSON object/)
  })

  it('throws INVALID_INPUT on unknown top-level key (typo guard)', async () => {
    await writeHeadersFile(homeDir, 'eval', { defaults: { Foo: 'oops' } })
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/unknown top-level key/)
  })

  it('throws INVALID_INPUT when a business key has a path component', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      businesses: { 'https://shop.example.com/api': { Foo: 'bar' } },
    })
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/bare origin/)
  })

  it('throws INVALID_INPUT when a header value is non-string', async () => {
    await writeHeadersFile(homeDir, 'eval', { default: { Foo: 42 } })
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/must be a string/)
  })

  it('throws INVALID_INPUT when a header value contains CR/LF', async () => {
    await writeHeadersFile(homeDir, 'eval', { default: { Foo: 'a\nb' } })
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/CR or LF/)
  })

  it('throws INVALID_INPUT when a header name has invalid chars', async () => {
    await writeHeadersFile(homeDir, 'eval', { default: { 'Foo Bar': 'bar' } })
    await expect(
      resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN }),
    ).rejects.toThrow(/invalid header name/)
  })

  it('does NOT read headers.json when profile is undefined', async () => {
    await writeHeadersFile(homeDir, 'eval', { default: { 'Trace-Id': 'config' } })
    const result = await resolveHeaders({ env: {}, homeDir, origin: ORIGIN })
    expect(result['Trace-Id']).toBeUndefined()
  })
})

describe('resolveHeaders — full merge order', () => {
  let homeDir: string

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'ucp-cli-headers-merge-'))
  })

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  it('low-to-high priority: builtin < default < business < flag', async () => {
    // Three layers conflict on Foo + Authorization. Verify flag wins.
    await writeHeadersFile(homeDir, 'eval', {
      default: { Foo: 'from-default', Authorization: 'Bearer from-default' },
      businesses: {
        [ORIGIN]: { Foo: 'from-business', Authorization: 'Bearer from-business' },
      },
    })
    const result = await resolveHeaders({
      env: {},
      homeDir,
      profile: 'eval',
      origin: ORIGIN,
      argFlags: ['Foo: from-flag', 'Authorization: Bearer from-flag'],
    })
    expect(result.Foo).toBe('from-flag')
    expect(result.Authorization).toBe('Bearer from-flag')
  })

  it('non-conflicting headers from all sources all ship', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { 'Default-Marker': 'd' },
      businesses: { [ORIGIN]: { 'Business-Marker': 'b' } },
    })
    const result = await resolveHeaders({
      env: {},
      homeDir,
      profile: 'eval',
      origin: ORIGIN,
      argFlags: ['Flag-Marker: f'],
    })
    expect(result).toMatchObject({
      'Default-Marker': 'd',
      'Business-Marker': 'b',
      'Flag-Marker': 'f',
    })
    expect(result['User-Agent']).toMatch(/^@shopify\/ucp-cli\//)
  })

  it('merge is case-insensitive on header name (last-set casing emitted)', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      default: { foo: 'lowercase' },
    })
    const result = await resolveHeaders({
      env: {},
      homeDir,
      profile: 'eval',
      origin: ORIGIN,
      argFlags: ['FOO: uppercase-wins'],
    })
    expect(result.FOO).toBe('uppercase-wins')
    expect(result.foo).toBeUndefined()
  })

  it('per-origin block selection is exact-match on canonical origin', async () => {
    await writeHeadersFile(homeDir, 'eval', {
      businesses: {
        [ORIGIN]: { 'Primary-Marker': 'yes' },
        [OTHER_ORIGIN]: { 'Secondary-Marker': 'yes' },
      },
    })
    const a = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: ORIGIN })
    expect(a['Primary-Marker']).toBe('yes')
    expect(a['Secondary-Marker']).toBeUndefined()
    const b = await resolveHeaders({ env: {}, homeDir, profile: 'eval', origin: OTHER_ORIGIN })
    expect(b['Secondary-Marker']).toBe('yes')
    expect(b['Primary-Marker']).toBeUndefined()
  })
})
