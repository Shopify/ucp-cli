// core/proxy.ts — proxy env detection + undici dispatcher install.
//
// Two layers, deliberately:
//
//   1. Unit tests with an injected undici loader. This is the only way to
//      prove the *conditional* half of the contract: no proxy env means the
//      ~37 ms undici load never happens at all.
//   2. Fixture-proxy tests against real undici over loopback sockets. These
//      are what make the conditional design defensible: CONNECT tunnelling
//      and no_proxy matching are the risky half of proxy support, and an
//      install that silently no-ops — e.g. undici's globalThis
//      dispatcher-symbol handshake drifting from what Node's bundled copy
//      reads — is otherwise a regression that only reproduces on a machine
//      behind a real proxy. Loopback only, so they run in `pnpm test`.

import { createServer, type Server } from 'node:http'
import { type AddressInfo, connect } from 'node:net'

import { Agent, setGlobalDispatcher } from 'undici'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearProxyEnv } from '../test-utils.js'
import {
  describeProxyState,
  installProxyDispatcher,
  proxyErrorContext,
  proxyErrorNote,
  proxyState,
  resetProxyStateForTests,
} from './proxy.js'

/**
 * A developer or CI runner that is itself behind a proxy must not change any
 * result here. Every test starts from a known-empty proxy environment.
 */
function isolateProxyEnv(): void {
  clearProxyEnv(vi.stubEnv)
}

/** Undici double that records loads and installs without opening sockets. */
function stubLoader() {
  const log = { loads: 0, installs: [] as unknown[] }
  const load = async () => {
    log.loads += 1
    return {
      EnvHttpProxyAgent: class StubAgent {},
      setGlobalDispatcher: (dispatcher: unknown) => {
        log.installs.push(dispatcher)
      },
    }
  }
  return { load, log }
}

interface FixtureServer {
  url: string
  close: () => Promise<void>
}

interface FixtureProxy extends FixtureServer {
  /**
   * Absolute-form targets seen (`GET http://host/path`). undici splits on
   * the request scheme: http is forwarded in absolute form, https is
   * tunnelled (see {@link FixtureProxy.tunneled}).
   *
   * Two things produce an http dispatch, neither of them ordinary use: the
   * loopback escape hatch in core/url.ts
   * (`UCP_TEST_ALLOW_INSECURE_LOCALHOST`, loopback hosts only), and a
   * redirect from an https origin to an http one — `fetch` follows that hop
   * itself, so parseHttpsUrl never sees the downgraded URL.
   */
  forwarded: string[]
  /**
   * CONNECT targets seen (`host:port`). Every https request tunnels, since
   * a proxy cannot rewrite bytes it cannot read without terminating TLS —
   * so this is the wire form of all production traffic, and permitting
   * CONNECT to the merchant hosts is what a proxy-side ACL has to do.
   * Pinned by test because it dictates that requirement.
   */
  tunneled: string[]
}

function listening(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

function closing(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    // Undici keeps the tunnel socket alive after the response, so close()
    // alone would wait forever for an idle keep-alive connection.
    server.closeAllConnections()
    server.close((err) => (err === undefined || err === null ? resolve() : reject(err)))
  })
}

/**
 * Minimal CONNECT proxy.
 *
 * `relay: true` completes the tunnel to the requested host, giving an
 * end-to-end assertion that a request really traversed the proxy. `relay:
 * false` refuses it, which is how we assert the CONNECT target for a host
 * that does not exist without needing a TLS endpoint and a trusted cert in
 * the test. `refuseWith` supplies the raw refusal, so a real corporate
 * failure (407) can be reproduced byte-for-byte.
 */
async function startFixtureProxy(
  opts: { relay?: boolean; refuseWith?: string } = {},
): Promise<FixtureProxy> {
  const forwarded: string[] = []
  const tunneled: string[] = []
  const server = createServer((req, res) => {
    forwarded.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('via-fixture-proxy')
  })
  server.on('connect', (req, clientSocket, head) => {
    const target = req.url ?? ''
    tunneled.push(target)
    if (opts.relay !== true) {
      clientSocket.end(opts.refuseWith ?? 'HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    // Split on the LAST colon so an IPv6 literal host stays intact.
    const split = target.lastIndexOf(':')
    const upstream = connect(Number(target.slice(split + 1)), target.slice(0, split), () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  const url = await listening(server)
  return { url, forwarded, tunneled, close: () => closing(server) }
}

async function startDirectTarget(): Promise<FixtureServer & { hits: string[] }> {
  const hits: string[] = []
  const server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('direct')
  })
  const url = await listening(server)
  return { url, hits, close: () => closing(server) }
}

beforeEach(() => {
  isolateProxyEnv()
})

afterEach(() => {
  // The dispatcher is process-global; restore a plain one so a proxied test
  // cannot leak into a later one.
  setGlobalDispatcher(new Agent())
  vi.unstubAllEnvs()
})

describe('installProxyDispatcher — conditional load', () => {
  it('skips the undici import entirely when no proxy env is set', async () => {
    const { load, log } = stubLoader()
    const state = await installProxyDispatcher({ load })
    expect(state.status).toBe('inactive')
    expect(state.vars).toEqual([])
    // The whole point of the conditional design: the common path pays nothing.
    expect(log.loads).toBe(0)
    expect(log.installs).toHaveLength(0)
  })

  it('installs a dispatcher when https_proxy is set', async () => {
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    const { load, log } = stubLoader()
    const state = await installProxyDispatcher({ load })
    expect(state.status).toBe('active')
    expect(log.loads).toBe(1)
    expect(log.installs).toHaveLength(1)
    expect(state.vars).toEqual(['https_proxy=http://proxy.example:3128'])
  })

  it.each([
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
  ])('triggers on %s (case handling is undici\u2019s job, presence detection is ours)', async (name) => {
    vi.stubEnv(name, 'http://proxy.example:3128')
    const { load } = stubLoader()
    expect((await installProxyDispatcher({ load })).status).toBe('active')
  })

  it('treats an empty proxy value as unset (`export https_proxy=` idiom)', async () => {
    vi.stubEnv('https_proxy', '')
    const { load, log } = stubLoader()
    const state = await installProxyDispatcher({ load })
    expect(state.status).toBe('inactive')
    expect(log.loads).toBe(0)
    // Still reported, so `ucp doctor` can explain why we are not proxying.
    expect(state.vars).toEqual(['https_proxy='])
  })

  it('treats a whitespace-only proxy value as unset', async () => {
    // Regression guard: `new EnvHttpProxyAgent()` throws `Invalid URL` on a
    // whitespace-only value, which would turn a user typo into a total
    // outage. Trimming keeps it a direct connection instead.
    vi.stubEnv('https_proxy', '   ')
    const { load, log } = stubLoader()
    expect((await installProxyDispatcher({ load })).status).toBe('inactive')
    expect(log.loads).toBe(0)
  })

  it('does not install for no_proxy alone, but reports it', async () => {
    vi.stubEnv('no_proxy', '.internal.example')
    const { load, log } = stubLoader()
    const state = await installProxyDispatcher({ load })
    expect(state.status).toBe('inactive')
    expect(log.loads).toBe(0)
    expect(state.vars).toEqual(['no_proxy=.internal.example'])
  })

  it('records an error instead of throwing when undici cannot be loaded', async () => {
    // A broken install (vendored dist without deps) must not stop
    // `ucp --version` from working.
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    const state = await installProxyDispatcher({
      load: () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND')),
    })
    expect(state.status).toBe('error')
    expect(state.error).toContain('ERR_MODULE_NOT_FOUND')
    // On a supported Node the version hint must NOT appear — it would point
    // users at an upgrade that cannot help them.
    expect(state.error).not.toContain('requires Node')
  })

  it.each([
    ['22.10.0', true],
    ['22.19.0', false],
    ['22.19.1', false],
    ['22.19.0-rc.1', true],
    ['22.20.0-nightly20250101', false],
  ] as const)('gates the load-failure hint on the full Node %s version', async (version, expectsHint) => {
    // The annotation is version-based, not global-sniffing, so it covers
    // whichever missing API undici happens to encounter below the floor.
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    const descriptor = Object.getOwnPropertyDescriptor(process.versions, 'node')
    Object.defineProperty(process.versions, 'node', { ...descriptor, value: version })
    try {
      const state = await installProxyDispatcher({
        load: () => Promise.reject(new ReferenceError('File is not defined')),
      })
      expect(state.status).toBe('error')
      expect(state.error).toContain('File is not defined')
      const hint = `(Node v${version}; ucp requires Node >= ${__MIN_NODE_VERSION__})`
      if (expectsHint) expect(state.error).toContain(hint)
      else expect(state.error).not.toContain('requires Node')
    } finally {
      Object.defineProperty(process.versions, 'node', descriptor as PropertyDescriptor)
    }
  })

  it('records an error instead of throwing when the proxy URL is malformed', async () => {
    // Real undici here: the throw we are catching is genuinely its own.
    vi.stubEnv('https_proxy', 'not-a-url')
    const state = await installProxyDispatcher()
    expect(state.status).toBe('error')
    expect(state.error).toContain('Invalid URL')
  })
})

describe('proxy state reporting', () => {
  it('redacts proxy credentials', async () => {
    vi.stubEnv('https_proxy', 'http://alice:s3cret@proxy.example:3128')
    const { load } = stubLoader()
    const state = await installProxyDispatcher({ load })
    const rendered = `${state.vars.join(',')} ${describeProxyState()}`
    expect(rendered).not.toContain('s3cret')
    expect(rendered).toContain('***')
    // Username survives; it is useful for debugging and is not the secret.
    expect(rendered).toContain('alice')
  })

  // Every entry below is a shape that leaked a password past an earlier
  // version of the redactor. They are regression pins, not hypotheticals: the
  // value is rendered into `ucp doctor` output and error messages, which for
  // an agent-driven CLI means a log aggregator or a model provider.
  it.each([
    ['ht!tp://alice:s3cret@proxy.example', 'malformed scheme, so URL parsing fails'],
    [
      'alice:s3cret@proxy.example:3128',
      'scheme-less — curl accepts it, and `new URL` reads `alice:` as the scheme',
    ],
    [
      '  http://alice:s3cret@proxy.example:3128',
      'leading whitespace from `export https_proxy=" http://..."`',
    ],
    ['http://a:s3cret@b:s3cret@c', 'doubled userinfo — stopping at the first @ exposes the second'],
    ['http://alice%3As3cret@proxy.example', 'percent-encoded separator'],
    ['http://alice:s3cret\nX-Injected: 1@proxy.example', 'newline in the password'],
    ['http://:s3cret@proxy.example', 'empty username'],
    ['http://alice:s3cret@[::1]:3128', 'IPv6 literal host'],
  ])('never echoes a password: %s', async (value) => {
    vi.stubEnv('https_proxy', value)
    const { load } = stubLoader()
    const state = await installProxyDispatcher({ load })
    const rendered = `${state.vars.join(',')} ${describeProxyState()} ${proxyErrorNote()}`
    expect(rendered).not.toContain('s3cret')
    expect(rendered).toContain('***')
  })

  it('leaves a credential-free value byte-for-byte intact', async () => {
    // Redaction must not quietly rewrite what the user typed, or `ucp doctor`
    // output stops matching `echo $https_proxy` and looks like a second bug.
    vi.stubEnv('https_proxy', 'http://proxy.corp.example:3128')
    const { load } = stubLoader()
    const state = await installProxyDispatcher({ load })
    expect(state.vars).toEqual(['https_proxy=http://proxy.corp.example:3128'])
  })

  it('reports "not initialized" rather than inventing an environment claim', () => {
    // Only reachable if the bin.ts install call is dropped. The point is that
    // it says so: reporting "no proxy env" here would state a falsehood about
    // a proxied machine because of a wiring bug in our own boot path.
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    resetProxyStateForTests()
    expect(describeProxyState()).toBe('state unknown (proxy setup did not run)')
    // State still reports the environment truthfully, redacted as always.
    expect(proxyState()).toEqual({
      status: 'inactive',
      vars: ['https_proxy=http://proxy.example:3128'],
    })
  })

  it('omits error context entirely when no proxy is configured', async () => {
    await installProxyDispatcher()
    expect(proxyErrorContext()).toBeUndefined()
    expect(describeProxyState()).toBe('none configured; connecting directly')
  })

  it('carries state into error context when active', async () => {
    vi.stubEnv('https_proxy', 'http://proxy.example:3128')
    const { load } = stubLoader()
    await installProxyDispatcher({ load })
    expect(proxyErrorContext()).toEqual({ proxy: proxyState() })
    // The summary names the variable the CLI picked up — the actionable
    // fact — not the library doing the routing.
    expect(describeProxyState()).toBe('enabled (https_proxy=http://proxy.example:3128)')
  })

  it('describes a failed install as the cause of direct requests', async () => {
    vi.stubEnv('https_proxy', 'not-a-url')
    await installProxyDispatcher()
    expect(proxyErrorContext()).toEqual({ proxy: proxyState() })
    expect(describeProxyState()).toContain('set but unusable')
    expect(describeProxyState()).toContain('connecting directly')
  })
})

describe('routing through a fixture proxy (real undici)', () => {
  it('forwards plain http to the proxy in absolute form', async () => {
    // `relay: true` even though no tunnel is expected: if the scheme split
    // ever changes, the fixture completes the CONNECT and the failure is a
    // readable assertion diff instead of a socket error.
    const proxy = await startFixtureProxy({ relay: true })
    const origin = await startDirectTarget()
    try {
      vi.stubEnv('http_proxy', proxy.url)
      expect((await installProxyDispatcher()).status).toBe('active')

      const res = await fetch(`${origin.url}/profile.json`)
      // An install that silently no-ops answers 'direct' with a hit on the
      // origin, so this block is what proves the dispatcher is live and the
      // request reached the proxy rather than the origin.
      expect(await res.text()).toBe('via-fixture-proxy')
      expect(origin.hits).toEqual([])
      expect(proxy.forwarded).toEqual([`${origin.url}/profile.json`])
      expect(proxy.tunneled).toEqual([])
    } finally {
      await Promise.all([proxy.close(), origin.close()])
    }
  })

  it('tunnels https requests with CONNECT host:443', async () => {
    const proxy = await startFixtureProxy()
    try {
      vi.stubEnv('https_proxy', proxy.url)
      expect((await installProxyDispatcher()).status).toBe('active')

      // The fixture refuses the tunnel, so the request must fail — the
      // assertion that matters is the CONNECT line it saw first.
      await expect(fetch('https://merchant.invalid/profile.json')).rejects.toThrow()
      expect(proxy.tunneled).toEqual(['merchant.invalid:443'])
      // Nothing in absolute form: an https origin shows the proxy a CONNECT
      // and nothing else, which is why CONNECT is the ACL requirement.
      expect(proxy.forwarded).toEqual([])
    } finally {
      await proxy.close()
    }
  })

  it('surfaces a proxy 407 as a proxy failure, not a merchant failure', async () => {
    // The most common corporate failure: authentication required. Nothing
    // about the merchant is wrong, and the error must not imply otherwise.
    const proxy = await startFixtureProxy({
      refuseWith:
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="corp"\r\n\r\n',
    })
    try {
      vi.stubEnv('https_proxy', proxy.url)
      expect((await installProxyDispatcher()).status).toBe('active')

      const err = await fetch('https://merchant.invalid/profile.json').catch((e: Error) => e)
      expect(err).toBeInstanceOf(Error)
      expect(proxy.tunneled).toEqual(['merchant.invalid:443'])

      // The 407 is real but buried: undici nests it several `cause` levels
      // deep, and the CLI's error framework lifts only the outermost message
      // ("fetch failed"). Pinned to document that the annotation from
      // proxyErrorNote() is what carries the diagnosis today.
      const chain: string[] = []
      for (let e: unknown = err; e instanceof Error; e = e.cause) chain.push(e.message)
      expect(chain[0]).toBe('fetch failed')
      expect(chain.join(' | ')).toContain('407')
    } finally {
      await proxy.close()
    }
  })

  it('bypasses the proxy for no_proxy hosts', async () => {
    const proxy = await startFixtureProxy()
    const direct = await startDirectTarget()
    try {
      vi.stubEnv('http_proxy', proxy.url)
      vi.stubEnv('no_proxy', '127.0.0.1')
      expect((await installProxyDispatcher()).status).toBe('active')

      const res = await fetch(`${direct.url}/bypass`)
      expect(await res.text()).toBe('direct')
      expect(direct.hits).toEqual(['/bypass'])
      // Both wire forms, so the assertion stays load-bearing whichever one
      // the scheme would otherwise have selected.
      expect(proxy.forwarded).toEqual([])
      expect(proxy.tunneled).toEqual([])
    } finally {
      await Promise.all([proxy.close(), direct.close()])
    }
  })
})
