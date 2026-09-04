// Per-release spec registry.
//
// The spec's version model is exact-version equality: an agent profile
// declares ONE `ucp.version`, the business validates that exact version, and
// a platform that speaks several releases hosts several profiles. This module
// is the data layer for that model — every version-specific artifact
// (validation schemas, reverse-domain key pattern, published agent-profile
// identity) is a lookup on a `SpecRelease` instead of a build-time define.
//
// This table is the ONLY home for a version-specific value. Adding a release
// is codegen plus one entry here; dropping one is deleting both. A version
// read from anywhere else — a build define, a package.json field, a hardcoded
// string in a message — is a bug.
//
// ── Typing decision ────────────────────────────────────────────────────────
//
// The two releases' generated profile types are NOT structurally identical
// (2026-04-08 has top-level `signing_keys`, 2026-08-25 renamed it `keys`;
// nested entity shapes differ in places). `SpecRelease` is therefore a narrow
// common interface whose schema fields are typed against the UNION of the
// per-release inferred types:
//
//   businessProfileSchema: ZodType<BusinessProfile>   // union output
//
// This works without casts because zod 4 declares `ZodType<out Output, ...>`
// covariant: a schema whose output is the 2026-04-08 profile IS a
// `ZodType<2026-04-08 | 2026-08-25>`. The union is also the honest story for
// consumers: a profile parsed through the registry came from *some* supported
// release, and code that needs release-specific fields (`keys` vs
// `signing_keys`) must narrow — by which release entry it holds, NOT by
// inspecting the value (the generated types carry `version: string`, not a
// literal, so the union is not data-discriminable at the type level).
// Code that statically knows its release should import that release's
// generated module directly instead of widening through the registry.

import type { ZodType } from 'zod'

import {
  agentProfileJson as agentProfileJson20260408,
  agentProfileUrl as agentProfileUrl20260408,
} from './generated/2026-04-08/agent_profile.js'
import {
  type BusinessProfile as BusinessProfile20260408,
  businessProfileSchema as businessProfileSchema20260408,
} from './generated/2026-04-08/business_profile.zod.js'
import {
  type PlatformProfile as PlatformProfile20260408,
  platformProfileSchema as platformProfileSchema20260408,
} from './generated/2026-04-08/platform_profile.zod.js'
import { reverseDomainPattern as reverseDomainPattern20260408 } from './generated/2026-04-08/reverse_domain.js'
import {
  agentProfileJson as agentProfileJson20260825,
  agentProfileUrl as agentProfileUrl20260825,
} from './generated/2026-08-25/agent_profile.js'
import {
  type BusinessProfile as BusinessProfile20260825,
  businessProfileSchema as businessProfileSchema20260825,
} from './generated/2026-08-25/business_profile.zod.js'
import {
  type PlatformProfile as PlatformProfile20260825,
  platformProfileSchema as platformProfileSchema20260825,
} from './generated/2026-08-25/platform_profile.zod.js'
import { reverseDomainPattern as reverseDomainPattern20260825 } from './generated/2026-08-25/reverse_domain.js'

/** Spec releases this CLI ships schemas for. */
export type Version = '2026-04-08' | '2026-08-25'

/**
 * A business profile valid under one of the supported releases. See the
 * typing-decision note in the header: not data-discriminable, narrow by
 * release entry.
 */
export type BusinessProfile = BusinessProfile20260408 | BusinessProfile20260825

/** A platform (agent) profile valid under one of the supported releases. */
export type PlatformProfile = PlatformProfile20260408 | PlatformProfile20260825

/** Everything version-specific the CLI knows about one spec release. */
export interface SpecRelease {
  version: Version
  /** Validates business profiles (`/.well-known/ucp` documents) of this release. */
  businessProfileSchema: ZodType<BusinessProfile>
  /** Validates platform (agent) profiles of this release. */
  platformProfileSchema: ZodType<PlatformProfile>
  /** This release's `reverse_domain_name` pattern (registry keys, extension keys). */
  reverseDomainPattern: RegExp
  /** Published Shopify agent profile the CLI presents as its hosted identity. */
  defaultAgentProfileUrl: string
  /**
   * Verbatim body served by `defaultAgentProfileUrl` at codegen time.
   * Byte-level source of truth for profile-drift diffing (`ucp doctor`).
   */
  agentProfileJson: string
  /**
   * `agentProfileJson`, parsed. What `profile init --version <v>` writes to
   * disk (cloned per call — the user may edit their local copy).
   *
   * Deliberately NOT run through `platformProfileSchema.parse`: zod fills
   * defaults (e.g. `ucp.status`), which would silently diverge the written
   * document from the published bytes and make `ucp doctor`'s drift diff
   * report a difference on every clean install. Schema validity is enforced
   * at codegen time (the generator refuses to emit a snapshot its release
   * schema rejects) and re-checked in releases.test.ts.
   */
  agentProfileTemplate: PlatformProfile
}

const RELEASE_2026_04_08: SpecRelease = {
  version: '2026-04-08',
  businessProfileSchema: businessProfileSchema20260408,
  platformProfileSchema: platformProfileSchema20260408,
  reverseDomainPattern: reverseDomainPattern20260408,
  defaultAgentProfileUrl: agentProfileUrl20260408,
  agentProfileJson: agentProfileJson20260408,
  // Cast, not parse — see agentProfileTemplate doc comment above.
  agentProfileTemplate: JSON.parse(agentProfileJson20260408) as PlatformProfile20260408,
}

const RELEASE_2026_08_25: SpecRelease = {
  version: '2026-08-25',
  businessProfileSchema: businessProfileSchema20260825,
  platformProfileSchema: platformProfileSchema20260825,
  reverseDomainPattern: reverseDomainPattern20260825,
  defaultAgentProfileUrl: agentProfileUrl20260825,
  agentProfileJson: agentProfileJson20260825,
  agentProfileTemplate: JSON.parse(agentProfileJson20260825) as PlatformProfile20260825,
}

/** Registry of supported releases, keyed by exact `ucp.version`. */
export const RELEASES: Readonly<Record<Version, SpecRelease>> = Object.freeze({
  '2026-04-08': RELEASE_2026_04_08,
  '2026-08-25': RELEASE_2026_08_25,
})

/** Supported versions, sorted ascending (ISO dates sort lexicographically). */
export const SUPPORTED_VERSIONS: readonly Version[] = Object.freeze([
  RELEASE_2026_04_08.version,
  RELEASE_2026_08_25.version,
])

/** Most recent supported release. */
export const LATEST: Version = '2026-08-25'

/** True when `v` names a release this CLI ships schemas for. */
export function isSupportedVersion(v: string): v is Version {
  const versions: readonly string[] = SUPPORTED_VERSIONS
  return versions.includes(v)
}

/** Exact-version registry lookup; `undefined` for anything we do not ship. */
export function release(v: string): SpecRelease | undefined {
  return isSupportedVersion(v) ? RELEASES[v] : undefined
}
