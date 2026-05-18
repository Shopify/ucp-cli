import { ErrorCodes, UcpError } from '../lib/errors.js'

// UCP_TEST_ALLOW_INSECURE_LOCALHOST bypasses the https-only check for loopback
// addresses. Intended exclusively for automated tests and local fixture servers
// — never set in production. The TEST infix is deliberate: this is not a stable
// deployment knob, and the loopback check prevents accidental remote downgrade.
function allowInsecureLocalhost(): boolean {
  return process.env.UCP_TEST_ALLOW_INSECURE_LOCALHOST === 'true'
}

function isLoopback(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
}

export function acceptsHttpsUrl(input: string): boolean {
  try {
    parseHttpsUrl(input, 'URL')
    return true
  } catch {
    return false
  }
}

// Bare-hostname heuristic: agents (and humans) routinely write `shop.com` or
// `<shop>.myshopify.com` instead of the full URL. Rather than failing
// with "is not a valid URL", canonicalize to `https://<input>` when the input
// looks like a hostname (and only then). Strict rules so we never silently
// upgrade something path-shaped or already URL-shaped:
//   - must contain a dot (avoids `localhost`, single-token typos)
//   - must NOT contain `/`, `?`, `#`, `@`, or whitespace (rules out paths,
//     query strings, userinfo, and anything that's clearly not a hostname)
//   - must NOT already start with a scheme (`http://`, `https://`)
//   - port suffix `:NNN` is allowed (`shop.example.com:8443`)
// Loopback (`localhost`, `127.0.0.1`) is intentionally NOT canonicalized:
// the http-loopback test escape hatch needs an explicit scheme to fire, and
// agents asking to talk to localhost without a scheme are almost certainly
// confused about something else.
const HOSTNAME_BODY_RE = /^[a-zA-Z0-9.-]+(?::\d+)?$/

function looksLikeBareHostname(input: string): boolean {
  if (input.length === 0) return false
  if (/^https?:\/\//i.test(input)) return false
  if (!input.includes('.')) return false
  return HOSTNAME_BODY_RE.test(input)
}

export function parseHttpsUrl(input: string, label: string): URL {
  const candidate = looksLikeBareHostname(input) ? `https://${input}` : input
  let url: URL
  try {
    url = new URL(candidate)
  } catch (err) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${label} is not a valid URL: ${input}`,
      cause: err as Error,
    })
  }

  if (
    url.protocol !== 'https:' &&
    !(allowInsecureLocalhost() && url.protocol === 'http:' && isLoopback(url))
  ) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: `${label} must use https: ${input}`,
    })
  }

  return url
}
