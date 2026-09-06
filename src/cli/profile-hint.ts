// The `PROTOCOL_VERSION_INCOMPATIBLE` recovery hint.
//
// When the business does not offer the version the ACTIVE profile speaks, the
// remedy is either "upgrade the CLI" (the business is outside our window) or
// "switch profiles" (some other local profile speaks a version it offers).
// Only the CLI layer can tell those apart: `core/profile.ts` knows the two
// version sets but not what profiles exist on this machine, so it throws with
// `context.offered` and this module supplies the switchable names.
//
// A local profile's version comes from `profile.json`, the same document the
// request path uses for negotiation. The profile URL is deliberately irrelevant
// here: `ucp doctor` separately reports any disagreement between the file and
// what that URL serves.

import type { listProfiles, readUserProfile } from '../core/profile-store.js'
import { isSupportedVersion, type Version } from '../core/releases.js'
import type { CtaBlock } from '../lib/types.js'

export interface ProfileHintDeps {
  listProfiles: typeof listProfiles
  readUserProfile: typeof readUserProfile
}

export interface ProfileVersionCandidate {
  name: string
  version: Version
}

/**
 * Local profiles (excluding `activeName`) whose `profile.json` declares a
 * version in `offered`. Best-effort: an unreadable profile is skipped, never
 * fatal — this decorates an error that has already happened.
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
    let version: string
    try {
      version = (await deps.readUserProfile(name)).body.ucp.version
    } catch {
      continue
    }
    if (!isSupportedVersion(version) || !offered.includes(version)) continue
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
 * else that profile declares (services and capabilities), and picking for the
 * user hides the choice.
 */
export function buildProfileSwitchCta(
  matches: readonly ProfileVersionCandidate[],
  context: { command: string; displayName: string },
): CtaBlock | undefined {
  if (matches.length === 0) return undefined
  const summary = matches.map((m) => `'${m.name}' speaks ${m.version}`).join(', ')
  return {
    description: `The business offers a version one of your other local profiles speaks (${summary}) — the protocol version comes from the ACTIVE profile's profile.json, so switching profiles switches version. No reinstall.`,
    commands: matches.map((m) => ({
      command: `${context.displayName} ${context.command} --profile ${m.name}`.trim(),
      description: `retry as UCP ${m.version}`,
    })),
  }
}
