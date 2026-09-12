// The `PROTOCOL_VERSION_INCOMPATIBLE` recovery hint.
//
// This hint applies only when the active body source is a singleton DIY
// Profile AND its URL is not explicitly overridden. The virtual managed
// Profile is then an alternative whenever the
// Business offers an installed release, and matching local Profiles can be
// retried directly by name. A managed local alias is eligible for every
// installed rendering; a DIY candidate is eligible only for its body version.
//
// Managed runtime failures never scan local aliases: managed already offered
// every installed rendering. Any explicit URL override never suggests a
// profile-name switch either, even with a DIY body:
// --profile-url/UCP_AGENT_PROFILE_URL outranks that switch.

import type { ProfileKind } from '../core/legacy-profile.js'
import type { listProfiles, readUserProfile } from '../core/profile-store.js'
import { isSupportedVersion, SUPPORTED_VERSIONS, type Version } from '../core/releases.js'
import type { CtaBlock } from '../lib/types.js'

export interface ProfileHintDeps {
  listProfiles: typeof listProfiles
  readUserProfile: typeof readUserProfile
}

export interface ProfileVersionCandidate {
  name: string
  kind: ProfileKind
  /** DIY body version, or the newest installed Business-offered version for managed. */
  version: Version
}

function newestInstalledOffered(offered: readonly string[]): Version | undefined {
  return SUPPORTED_VERSIONS.filter((version) => offered.includes(version)).at(-1)
}

/**
 * Local profiles (excluding `activeName`) that can negotiate an `offered`
 * release. A managed alias carries every installed rendering; a DIY Profile
 * carries only its body version. Best-effort: an unreadable Profile is skipped,
 * never fatal — this decorates an error that has already happened.
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
    let kind: ProfileKind
    let version: string | undefined
    try {
      const profile = await deps.readUserProfile(name, { migrate: false })
      kind = profile.kind
      version =
        profile.kind === 'managed' ? newestInstalledOffered(offered) : profile.body.ucp.version
    } catch {
      continue
    }
    if (version === undefined || !isSupportedVersion(version) || !offered.includes(version))
      continue
    matches.push({ name, kind, version })
  }
  return matches.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Build the recovery CTA for a non-URL-overridden singleton DIY
 * `PROTOCOL_VERSION_INCOMPATIBLE`. The caller gates URL precedence before
 * invoking this helper. `undefined` when neither the virtual
 * managed Profile nor a local Profile can negotiate a Business-offered
 * installed release.
 *
 * ALL local matches are named, not just the first: which one to use depends on
 * what else that Profile declares (services and capabilities), and picking for
 * the user hides the choice.
 */
export function buildProfileSwitchCta(
  matches: readonly ProfileVersionCandidate[],
  offered: readonly string[],
  context: { command: string; displayName: string },
): CtaBlock | undefined {
  const managedVersion = newestInstalledOffered(offered)
  if (managedVersion === undefined && matches.length === 0) return undefined

  const summaries = matches.map((match) =>
    match.kind === 'managed'
      ? `'${match.name}' is managed and selects newest mutual UCP ${match.version}`
      : `'${match.name}' speaks ${match.version}`,
  )
  const description = [
    'The active DIY Profile is a singleton.',
    ...(managedVersion === undefined
      ? []
      : [
          `The Shopify managed Profile offers every installed rendering and will select newest mutual UCP ${managedVersion}. Run \`ucp profile use --managed\`, then retry without an explicit --profile and with UCP_PROFILE unset. Both override active.yaml; leaving either pointed at the DIY Profile would keep it active.`,
        ]),
    ...(summaries.length === 0
      ? []
      : [`Other matching local Profiles: ${summaries.join(', ')}. No reinstall.`]),
  ].join(' ')

  return {
    description,
    commands: [
      ...(managedVersion === undefined
        ? []
        : [
            {
              command: 'ucp profile use --managed',
              description: `select the managed Profile; it will negotiate UCP ${managedVersion}`,
            },
          ]),
      ...matches.map((match) => ({
        command: `${context.displayName} ${context.command} --profile ${match.name}`.trim(),
        description:
          match.kind === 'managed'
            ? `retry with managed Profile '${match.name}', selecting UCP ${match.version}`
            : `retry as UCP ${match.version}`,
      })),
    ],
  }
}
