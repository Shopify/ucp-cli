// Resolve the active profile and target business for dispatch.
//
// Precedence is first-defined-wins:
//   profile:     option → UCP_PROFILE → active.yaml.profile → required local profile
//   profile URL: option → UCP_AGENT_PROFILE_URL → profile metadata → default
//   business:    option → UCP_BUSINESS → active.yaml.business
//
// The resolver returns what it can prove from local state. When a profile
// carries no `meta.profile_url`, the fallback is the latest release's PUBLISHED
// agent profile (`release(LATEST).defaultAgentProfileUrl`) — a real, reachable
// document, which matters because the business GETs this URL on every call
// and negotiates against what it serves.
//
// `ActiveProfile` stays a POINTER: `{name, profileUrl, meta}`. The identity
// document is not resolved here — `discover` does that from the URL plus the
// profile NAME (core/agent.ts: bundled snapshot for a release default, the
// local `profile.json` when self-hosted), with no request either way.
//
// v0.1/v0.2 local profile work: signing material is intentionally not threaded
// through. The profile body may advertise public keys later, but request
// signing remains a separate phase.

import { DEFAULT_CATALOG_URL } from '../core/profile.js'
import { type ProfileMeta, readActive, readUserProfile } from '../core/profile-store.js'
import { LATEST, RELEASES } from '../core/releases.js'
import { ErrorCodes, UcpError } from '../lib/errors.js'

export interface ActiveProfile {
  /** User-supplied local profile name. */
  name: string
  /**
   * Where this profile is hosted. `resolveSession` precedence:
   * option → `UCP_AGENT_PROFILE_URL` → `meta.profile_url` →
   * `release(LATEST).defaultAgentProfileUrl` (the published default identity).
   */
  profileUrl?: string
  /**
   * Per-machine meta from the profile's `meta.json`. Catalog resolution reads
   * `meta.defaults.catalog` here, not `package.json`.
   */
  meta?: ProfileMeta
}

/**
 * Where the resolved business URL came from. Used by --verbose to print a
 * one-liner at boot so agents can confirm precedence ate the right value
 * (e.g., a stale UCP_BUSINESS shadowing a newer `ucp use`).
 */
export type BusinessSource = 'flag' | 'env' | 'active.yaml'

export interface ResolvedSession {
  profile: ActiveProfile
  /** Resolved business URL. Empty string is treated as unset. */
  business?: string
  /** Where `business` came from. Undefined when `business` is undefined. */
  businessSource?: BusinessSource
}

export interface ResolveSessionOptions {
  /** `--profile <name>` flag override. */
  profile?: string
  /** `--profile-url <url>` flag override. Tops the precedence chain. */
  profileUrl?: string
  /** `--business <url>` flag override. */
  business?: string
  /** Override `$UCP_HOME` for tests. */
  homeDir?: string
  /** Override env-var lookup for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
}

/**
 * Resolve active profile and active business target.
 */
export async function resolveSession(opts: ResolveSessionOptions = {}): Promise<ResolvedSession> {
  const env = opts.env ?? process.env
  const storeOpts = opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}
  const active = await readActive(storeOpts)

  const profileName = opts.profile ?? env.UCP_PROFILE ?? active.profile
  // Walk precedence explicitly so we can pin the source label to the layer
  // that actually contributed the value. Empty string is "unset" (matches
  // historical behavior — env vars often default to '' under shells).
  let businessSource: BusinessSource | undefined
  let rawBusiness: string | undefined
  if (opts.business !== undefined && opts.business !== '') {
    rawBusiness = opts.business
    businessSource = 'flag'
  } else if (env.UCP_BUSINESS !== undefined && env.UCP_BUSINESS !== '') {
    rawBusiness = env.UCP_BUSINESS
    businessSource = 'env'
  } else if (active.business !== undefined && active.business !== '') {
    rawBusiness = active.business
    businessSource = 'active.yaml'
  }
  const business = rawBusiness

  if (profileName === undefined || profileName === '') {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.PROFILE_NOT_FOUND,
      message: 'no local profile selected',
      cta: {
        description: 'Create a local profile before running UCP operations.',
        commands: [
          {
            command: 'ucp profile init --name agent',
            description: 'create and activate a local profile',
          },
        ],
      },
    })
  }

  const user = await readUserProfile(profileName, storeOpts)
  const meta = withDefaultCatalog(user.meta, env.UCP_DEFAULT_CATALOG)
  // A profile with no `meta.profile_url` self-hosts nothing, so it presents
  // the release default: the published Shopify agent profile for the latest
  // supported release. Self-hosting (`--profile-url`, `UCP_AGENT_PROFILE_URL`,
  // or `meta.profile_url`) is how a user advertises a custom capability set;
  // both sides then read that URL.
  const profileUrl =
    opts.profileUrl ??
    env.UCP_AGENT_PROFILE_URL ??
    meta.profile_url ??
    RELEASES[LATEST].defaultAgentProfileUrl
  const profile: ActiveProfile = { name: profileName, profileUrl, meta }

  if (business !== undefined && businessSource !== undefined) {
    return { profile, business, businessSource }
  }
  return { profile }
}

// Resolution order for `meta.defaults.catalog`:
//   profile meta > UCP_DEFAULT_CATALOG env > baked-in DEFAULT_CATALOG_URL
// Profile wins because the user said so explicitly; env lets ops point a
// machine at a staging catalog without rewriting the local profile; baked-in
// is the floor so the catalog fallback rung is never accidentally empty.
function withDefaultCatalog(meta: ProfileMeta, envOverride: string | undefined): ProfileMeta {
  if (meta.defaults?.catalog !== undefined) return meta
  const fromEnv = envOverride !== undefined && envOverride !== '' ? envOverride : undefined
  const catalog = fromEnv ?? DEFAULT_CATALOG_URL
  return { ...meta, defaults: { ...(meta.defaults ?? {}), catalog } }
}
