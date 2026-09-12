// Resolve the runtime Profile and target Business for dispatch.
//
// Precedence is first-defined-wins:
//   profile name: option → UCP_PROFILE → active.yaml.profile → managed
//   profile URL:  option → UCP_AGENT_PROFILE_URL → named profile metadata →
//                 named body release default
//   business:     option → UCP_BUSINESS → active.yaml.business
//
// A named local profile starts from the store's persisted classification;
// this resolver turns that classification into the runtime rendering set. An
// authored (DIY) profile is a singleton pinned to its body release. A profile whose
// body is one ucp-cli generated — including every unmarked profile written by
// 0.4.2 … 0.8.0 — is managed, and gets the same multi-rendering Profile a
// fresh install gets, still carrying its local name for headers.json and
// messages. core/legacy-profile.ts owns that decision; nothing here inspects
// a body.
//
// With no name, the default is a managed Profile containing one independently
// hosted rendering per installed release. An explicit URL override always
// pins one rendering. For a named DIY Profile it replaces only the rendering
// URL: the exact locally authored body remains the declaration. For managed
// or nameless resolution there is no authored body to retain, so the override
// produces one ad-hoc bundled rendering (known published URLs select their
// release; unknown URLs use latest). A scalar URL is never spread across
// managed renderings.
//
// MCP mode does not read active.yaml. Explicit flags/env still apply; with no
// explicit Profile it gets the same managed default as a fresh CLI session.

import {
  createAdHocProfile,
  createDiyProfile,
  createManagedProfile,
  type Profile,
} from '../core/agent.js'
import { DEFAULT_CATALOG_URL } from '../core/profile.js'
import {
  type ActiveSession,
  type ProfileMeta,
  readActive,
  readUserProfile,
  type UserProfile,
} from '../core/profile-store.js'

/**
 * Where the resolved business URL came from. Used by --verbose to print a
 * one-liner at boot so agents can confirm precedence ate the right value.
 */
export type BusinessSource = 'flag' | 'env' | 'active.yaml'

export interface ResolvedSession {
  profile: Profile
  /**
   * Local-only metadata/defaults for this session. Required: every
   * resolution path produces one — a named profile's `meta.json`, or the
   * synthesized defaults a nameless session runs on — and catalog fallback
   * reads `defaults.catalog` off it unconditionally.
   */
  profileMeta: ProfileMeta
  /** Resolved business URL. Empty string is treated as unset. */
  business?: string
  /** Where `business` came from. Undefined when `business` is undefined. */
  businessSource?: BusinessSource
}

export interface ResolveSessionOptions {
  /** `--profile <name>` flag override. */
  profile?: string
  /** `--profile-url <url>` flag override. Tops the URL precedence chain. */
  profileUrl?: string
  /** `--business <url>` flag override. */
  business?: string
  /** Override `$UCP_HOME` for tests. */
  homeDir?: string
  /** Override env-var lookup for tests. Defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /**
   * Set by `ucp --mcp`. Drops both `active.yaml` precedence legs; explicit
   * flags and environment variables are unaffected.
   */
  inMcpMode?: boolean
}

/**
 * Turn one classified stored Profile into the runtime rendering set used for
 * planning and negotiation. Pure storage-to-runtime boundary: callers that
 * already hold a UserProfile reuse the exact validation session resolution
 * applies, including loadAgentProfile's cross-version snapshot invariant.
 */
export function materializeUserProfile(user: UserProfile, profileUrlOverride?: string): Profile {
  if (user.kind === 'managed') {
    return profileUrlOverride === undefined
      ? createManagedProfile(user.name)
      : createAdHocProfile(profileUrlOverride, user.name)
  }

  const selectedUrl = profileUrlOverride ?? user.meta.profile_url
  return createDiyProfile({
    name: user.name,
    body: user.body,
    urlOverride: profileUrlOverride !== undefined,
    // createDiyProfile derives the body release's published URL when no
    // explicit or stored URL exists.
    ...(selectedUrl !== undefined ? { url: selectedUrl } : {}),
  })
}

/** Resolve the Profile and active Business target. */
export async function resolveSession(opts: ResolveSessionOptions = {}): Promise<ResolvedSession> {
  const env = opts.env ?? process.env
  const storeOpts = opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}
  const active: ActiveSession = opts.inMcpMode === true ? {} : await readActive(storeOpts)

  const profileName = firstSet(opts.profile, env.UCP_PROFILE, active.profile)
  const profileUrlOverride = firstSet(opts.profileUrl, env.UCP_AGENT_PROFILE_URL)

  let profile: Profile
  let profileMeta: ProfileMeta
  if (profileName !== undefined) {
    // An explicit or active name must exist, and a missing or corrupt one
    // throws out of here. Never fall back to managed when a caller asked for
    // a specific local identity: silently selling under a different identity
    // than the operator named is worse than not selling.
    const user = await readUserProfile(profileName, storeOpts)
    profileMeta = withDefaultCatalog(user.meta, env.UCP_DEFAULT_CATALOG)
    profile = materializeUserProfile(user, profileUrlOverride)
  } else {
    profileMeta = withDefaultCatalog({}, env.UCP_DEFAULT_CATALOG)
    profile =
      profileUrlOverride === undefined
        ? createManagedProfile()
        : createAdHocProfile(profileUrlOverride)
  }

  let businessSource: BusinessSource | undefined
  let business: string | undefined
  if (isSet(opts.business)) {
    business = opts.business
    businessSource = 'flag'
  } else if (isSet(env.UCP_BUSINESS)) {
    business = env.UCP_BUSINESS
    businessSource = 'env'
  } else if (isSet(active.business)) {
    business = active.business
    businessSource = 'active.yaml'
  }

  if (business !== undefined && businessSource !== undefined) {
    return { profile, profileMeta, business, businessSource }
  }
  return { profile, profileMeta }
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== ''
}

function firstSet(...values: Array<string | undefined>): string | undefined {
  return values.find(isSet)
}

// Resolution order for catalog defaults:
//   local profile meta > UCP_DEFAULT_CATALOG > baked-in DEFAULT_CATALOG_URL.
function withDefaultCatalog(meta: ProfileMeta, envOverride: string | undefined): ProfileMeta {
  if (meta.defaults?.catalog !== undefined) return meta
  const fromEnv = isSet(envOverride) ? envOverride : undefined
  const catalog = fromEnv ?? DEFAULT_CATALOG_URL
  return { ...meta, defaults: { ...(meta.defaults ?? {}), catalog } }
}
