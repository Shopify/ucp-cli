// The `PROTOCOL_VERSION_INCOMPATIBLE` recovery hint.
//
// When the business does not offer the version the ACTIVE profile speaks, the
// remedy is either "upgrade the CLI" (the business is outside our window) or
// "switch profiles" (some other local profile speaks a version it offers).
// Only the CLI layer can tell those apart: `core/profile.ts` knows the two
// version sets but not what profiles exist on this machine, so it throws with
// `context.offered` and this module supplies the switchable names.
//
// ── Where a local profile's version comes from ─────────────────────────────
//
// From `meta.profile_url`, and only when that URL is a release default
// (`RELEASES[v].defaultAgentProfileUrl`) — there the version is known by
// construction, is exactly what the request path would negotiate (the bundled
// snapshot of that document), and cannot drift.
//
// Self-hosted profiles are omitted. Their version IS knowable now — it is
// their own `profile.json`, which core/agent.ts reads at request time — so
// this could list them too; it has simply not been extended, and a profile
// whose local copy disagrees with what it publishes would be a switch that
// lands somewhere the merchant does not see. `ucp doctor` is where that
// disagreement gets reported.

import type { listProfiles, readUserProfile } from '../core/profile-store.js'
import { RELEASES, type Version } from '../core/releases.js'
import type { CtaBlock } from '../lib/types.js'

export interface ProfileHintDeps {
  listProfiles: typeof listProfiles
  readUserProfile: typeof readUserProfile
}

/** URL → version, for release-default URLs only. Self-hosted URLs are absent. */
const VERSION_BY_DEFAULT_URL: ReadonlyMap<string, Version> = new Map(
  Object.values(RELEASES).map((rel) => [rel.defaultAgentProfileUrl, rel.version]),
)

export interface ProfileVersionCandidate {
  name: string
  version: Version
}

/**
 * Local profiles (excluding `activeName`) whose release-default profile URL
 * puts them at a version in `offered`. Best-effort: an unreadable profile is
 * skipped, never fatal — this decorates an error that has already happened.
 */
export async function localProfilesSpeaking(
  offered: readonly string[],
  activeName: string | undefined,
  deps: ProfileHintDeps,
): Promise<ProfileVersionCandidate[]> {
  let names: string[]
  try {
    names = await deps.listProfiles()
  } catch {
    return []
  }
  const matches: ProfileVersionCandidate[] = []
  for (const name of names) {
    if (name === activeName) continue
    let profileUrl: string | undefined
    try {
      profileUrl = (await deps.readUserProfile(name)).meta.profile_url
    } catch {
      continue
    }
    if (profileUrl === undefined) continue
    const version = VERSION_BY_DEFAULT_URL.get(profileUrl)
    if (version === undefined) continue
    if (!offered.includes(version)) continue
    matches.push({ name, version })
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Build the switch-profiles CTA for a `PROTOCOL_VERSION_INCOMPATIBLE`.
 * `undefined` when no local profile qualifies — in that case the error's own
 * message ("… offers … / ucp-cli supports …") already carries the only
 * available remedy, and an empty CTA would be worse than none.
 *
 * ALL matches are named, not just the first: which one to use depends on what
 * else that profile declares (capabilities, self-hosted extensions), and
 * picking for the user hides the choice.
 */
export function buildProfileSwitchCta(
  matches: readonly ProfileVersionCandidate[],
  context: { command: string; displayName: string },
): CtaBlock | undefined {
  if (matches.length === 0) return undefined
  const summary = matches.map((m) => `'${m.name}' speaks ${m.version}`).join(', ')
  return {
    description: `The business offers a version one of your other local profiles speaks (${summary}) — the protocol version comes from the ACTIVE profile, so switching profiles switches version. No reinstall.`,
    commands: matches.map((m) => ({
      command: `${context.displayName} ${context.command} --profile ${m.name}`.trim(),
      description: `retry as UCP ${m.version}`,
    })),
  }
}
