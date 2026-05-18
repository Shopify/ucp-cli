// `ucp profile *` command tree.
//
// Local profile work only: generate/inspect/select profiles and expose a
// publish seam. Managed upload is intentionally a no-op for now; the command
// grammar lands first so the client-side contract can stabilize independently
// of hosting infrastructure.

import { stdin as promptInput, stderr as promptOutput } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { Cli, z } from 'incur'
import { DEFAULT_CATALOG_URL, DEFAULT_PROFILE_URL, localAgentProfileBody } from '../core/profile.js'
import {
  MANAGED_PROFILE_URL_ORIGINS,
  noopUploadProfile,
  type ProfileUploadResult,
  type UploadProfile,
} from '../core/profile-publisher.js'
import {
  listProfiles,
  type ProfileMeta,
  profileDir,
  profileExists,
  readActive,
  readUserProfile,
  saveUserProfile,
  writeActive,
} from '../core/profile-store.js'
import { acceptsHttpsUrl, parseHttpsUrl } from '../core/url.js'
import { ErrorCodes, UcpError } from '../lib/errors.js'

export interface ProfileCliDependencies {
  listProfiles?: typeof listProfiles
  readUserProfile?: typeof readUserProfile
  saveUserProfile?: typeof saveUserProfile
  profileExists?: typeof profileExists
  readActive?: typeof readActive
  writeActive?: typeof writeActive
  uploadProfile?: UploadProfile
  /** Test override for prompt eligibility. Default derives from TTY + c.agent. */
  canPrompt?: boolean
  /** Test/user-interface injection. Default uses readline on stderr. */
  promptInit?: (defaults: InitPromptDefaults) => Promise<InitPromptResult>
}

const DEFAULT_PROTOCOL_RANGE = { min: __PROTOCOL_MIN__, max: __PROTOCOL_MAX__ }
const DEFAULT_PROFILE_NAME = 'agent'

// Protocol versions are ISO date strings (YYYY-MM-DD); negotiation logic in
// core/discover.ts string-compares them lexicographically. Reject anything
// off-shape at the CLI boundary so a typo doesn't surface later as a confusing
// "no compatible version" error during dispatch.
const DATE_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/

interface InitPromptDefaults {
  name: string
}

interface InitPromptResult {
  name?: string
  /** Optional HTTPS URL means the user will host profile.json themselves. */
  profileUrl?: string
}

function dateVersionOption(field: string) {
  return z
    .string()
    .refine((s) => DATE_VERSION_RE.test(s), { message: `${field} must be ISO YYYY-MM-DD` })
}

function optionalHttpsOption(field: string) {
  return z
    .string()
    .optional()
    .refine((value) => value === undefined || acceptsHttpsUrl(value), {
      message: `${field} must be an HTTPS URL`,
    })
}

function requireHttpsString(value: string, label: string): string {
  return parseHttpsUrl(value, label).toString()
}

function profileInitRequiresNameError(): {
  code: string
  message: string
  cta: {
    description: string
    commands: Array<{ command: string; description: string }>
  }
} {
  return {
    code: ErrorCodes.PROFILE_INIT_REQUIRES_NAME,
    message: 'profile init needs a profile name in non-interactive mode',
    cta: {
      description:
        'Pass a profile name. Omit --profile-url to create local profile files without configuring hosting yet; pass --profile-url when you will host profile.json yourself.',
      commands: [
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
          description: 'create a local profile; managed upload can be configured later',
        },
        {
          command: `ucp profile init --name ${DEFAULT_PROFILE_NAME} --profile-url https://example.com/.well-known/ucp`,
          description: 'create a local profile for a self-hosted HTTPS URL',
        },
      ],
    },
  }
}

async function promptForInit(defaults: InitPromptDefaults): Promise<InitPromptResult> {
  promptOutput.write('No UCP profile found.\n\n')
  promptOutput.write(
    'A UCP profile is a public JSON document businesses fetch to identify this agent and discover supported capabilities.\n\n',
  )
  promptOutput.write(
    'To use an existing profile, place profile.json and meta.json under ~/.ucp/profiles/<name>/, then run `ucp profile use <name>`.\n\n',
  )

  const rl = createInterface({ input: promptInput, output: promptOutput })
  try {
    const rawName = await rl.question(`Profile name [${defaults.name}]: `)
    const rawProfileUrl = await rl.question(
      'Profile URL (optional HTTPS; leave blank for managed hosting later): ',
    )
    const trimmedProfileUrl = rawProfileUrl.trim()
    return {
      name: rawName.trim() || defaults.name,
      ...(trimmedProfileUrl !== '' ? { profileUrl: trimmedProfileUrl } : {}),
    }
  } finally {
    rl.close()
  }
}

function applyUploadResult(meta: ProfileMeta, upload: ProfileUploadResult): ProfileMeta {
  return {
    ...meta,
    ...(upload.profileUrl !== undefined ? { profile_url: upload.profileUrl } : {}),
    ...(upload.profileId !== undefined ? { profile_id: upload.profileId } : {}),
    ...(upload.etag !== undefined ? { etag: upload.etag } : {}),
    ...(upload.publishedAt !== undefined ? { published_at: upload.publishedAt } : {}),
  }
}

function isManagedProfileUrl(profileUrl: string): boolean {
  try {
    return MANAGED_PROFILE_URL_ORIGINS.includes(new URL(profileUrl).origin)
  } catch {
    return false
  }
}

export function buildProfileCli(deps: ProfileCliDependencies = {}) {
  const list = deps.listProfiles ?? listProfiles
  const read = deps.readUserProfile ?? readUserProfile
  const save = deps.saveUserProfile ?? saveUserProfile
  const exists = deps.profileExists ?? profileExists
  const readAct = deps.readActive ?? readActive
  const writeAct = deps.writeActive ?? writeActive
  const upload = deps.uploadProfile ?? noopUploadProfile
  const prompt = deps.promptInit ?? promptForInit

  return Cli.create('profile', { description: 'Profile management' })
    .command('list', {
      description: 'List configured profiles (active is marked)',
      args: z.object({}),
      options: z.object({}),
      async run() {
        const [profiles, active] = await Promise.all([list(), readAct()])
        return {
          active: active.profile ?? null,
          profiles: profiles.map((name) => ({
            name,
            active: name === active.profile,
          })),
        }
      },
    })
    .command('show', {
      description: 'Display a profile (defaults to active)',
      args: z.object({ name: z.string().optional() }),
      options: z.object({}),
      async run(c) {
        const name = c.args.name ?? (await readAct()).profile
        if (name === undefined) {
          return c.error({
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: 'no local profile selected',
            cta: {
              description: 'Create a local profile first, then run show again.',
              commands: [
                {
                  command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
                  description: 'create and activate a local profile',
                },
              ],
            },
          })
        }
        return read(name)
      },
    })
    .command('init', {
      description: 'Create a local profile',
      args: z.object({}),
      options: z.object({
        name: z.string().optional().describe('Profile name (filesystem-safe identifier).'),
        profileUrl: optionalHttpsOption('--profile-url').describe(
          'Public HTTPS URL if you will host profile.json yourself. Omit to defer hosting; managed upload is not wired yet.',
        ),
        protocolMin: dateVersionOption('--protocol-min')
          .default(DEFAULT_PROTOCOL_RANGE.min)
          .describe('Minimum UCP protocol version this profile accepts (YYYY-MM-DD).'),
        protocolMax: dateVersionOption('--protocol-max')
          .default(DEFAULT_PROTOCOL_RANGE.max)
          .describe('Maximum UCP protocol version this profile accepts (YYYY-MM-DD).'),
        activate: z
          .boolean()
          .default(false)
          .describe(
            'Mark the new profile as active in active.yaml. The first profile is activated automatically.',
          ),
        force: z.boolean().default(false).describe('Re-create an existing profile in place.'),
        catalog: optionalHttpsOption('--catalog').describe(
          `Catalog business URL recorded as meta.defaults.catalog (discovery hits <url>/.well-known/ucp). If omitted, session resolution falls through to UCP_DEFAULT_CATALOG, then the baked-in default '${DEFAULT_CATALOG_URL}'.`,
        ),
      }),
      async run(c) {
        const canPrompt =
          deps.canPrompt ??
          (process.stdin.isTTY === true && process.stderr.isTTY === true && c.agent !== true)
        let name = c.options.name
        let profileUrl = c.options.profileUrl

        if (name === undefined && canPrompt) {
          const prompted = await prompt({ name: DEFAULT_PROFILE_NAME })
          name = prompted.name ?? name
          profileUrl = prompted.profileUrl ?? profileUrl
        }

        if (name === undefined) return c.error(profileInitRequiresNameError())

        if (!c.options.force && (await exists(name))) {
          // Idempotent no-op so agents can safely run `profile init` at the
          // start of a session without flooding output or mutating state.
          // Return shape mirrors the create case (`name` + `activated`) so a
          // caller doesn't need to branch on `created` to read either.
          return {
            name,
            created: false,
            activated: false,
            message: 'profile already exists; no changes made',
          }
        }

        let priorCreatedAt: string | undefined
        if (c.options.force && (await exists(name))) {
          try {
            const prior = await read(name)
            priorCreatedAt = prior.meta.created_at
          } catch {
            // Corrupt prior meta — fall back to a fresh timestamp rather
            // than refuse the re-init, which is exactly what --force is for.
          }
        }

        const profilesBefore = await list()
        const now = new Date().toISOString()
        const body = localAgentProfileBody()
        const baseMeta: ProfileMeta = {
          created_at: priorCreatedAt ?? now,
          updated_at: now,
          protocol_versions: { min: c.options.protocolMin, max: c.options.protocolMax },
          ...(c.options.catalog !== undefined ? { defaults: { catalog: c.options.catalog } } : {}),
          ...(profileUrl !== undefined
            ? { profile_url: requireHttpsString(profileUrl, 'profile URL') }
            : {}),
        }

        const uploadResult =
          profileUrl === undefined ? await upload({ name, body, meta: baseMeta }) : {}
        const meta = applyUploadResult(baseMeta, uploadResult)
        const profile = await save({ name, body, meta, overwrite: c.options.force })

        const shouldActivate = c.options.activate || profilesBefore.length === 0
        if (shouldActivate) {
          const prev = await readAct()
          await writeAct({ ...prev, profile: name })
        }
        // Terse envelope: omit `body` (the full ~5KB profile JSON) and
        // `meta` (signing keys, capabilities, etc.) which are agent
        // context noise on every init. Callers that want the full body
        // can run `ucp profile show <name>` or read profile.json directly
        // at the path returned here.
        return {
          name: profile.name,
          created: true,
          activated: shouldActivate,
          path: profileDir(profile.name),
          ...(profile.meta.profile_url !== undefined
            ? { profile_url: profile.meta.profile_url }
            : {}),
        }
      },
    })
    .command('publish', {
      description: 'Validate and publish a profile (managed upload is currently a no-op)',
      args: z.object({ name: z.string().optional() }),
      options: z.object({}),
      async run(c) {
        const name = c.args.name ?? (await readAct()).profile
        if (name === undefined) {
          return c.error({
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: 'no user profile selected',
            cta: {
              description: 'Create a local profile first, then run publish again.',
              commands: [
                {
                  command: `ucp profile init --name ${DEFAULT_PROFILE_NAME}`,
                  description: 'create a local profile',
                },
              ],
            },
          })
        }
        const profile = await read(name)
        const currentUrl = profile.meta.profile_url
        if (currentUrl !== undefined && !isManagedProfileUrl(currentUrl)) {
          return {
            profile: name,
            published: false,
            profile_path: `${profileDir(name)}/profile.json`,
            profile_url: currentUrl,
            cta: {
              description:
                'Upload profile.json to profile_url, serve Content-Type: application/json, and use Cache-Control: public, max-age>=300.',
              commands: [
                {
                  command: `cat ${profileDir(name)}/profile.json`,
                  description: 'inspect the profile artifact to upload',
                },
                {
                  command: `curl -I ${currentUrl}`,
                  description: 'verify the hosted profile URL after upload',
                },
              ],
            },
          }
        }

        const result = await upload({ name, body: profile.body, meta: profile.meta })
        if (result.profileUrl === undefined) {
          return {
            profile: name,
            published: false,
            upload: 'not_configured',
            profile_url: currentUrl ?? DEFAULT_PROFILE_URL,
          }
        }
        const updatedMeta: ProfileMeta = applyUploadResult(
          { ...profile.meta, updated_at: new Date().toISOString() },
          result,
        )
        const updated = await save({ name, body: profile.body, meta: updatedMeta, overwrite: true })
        return {
          profile: name,
          published: true,
          profile_url: result.profileUrl,
          meta: updated.meta,
        }
      },
    })
    .command('use', {
      description: 'Switch the active profile',
      args: z.object({ name: z.string() }),
      options: z.object({}),
      async run(c) {
        if (!(await exists(c.args.name))) {
          throw new UcpError({
            layer: 'client',
            code: ErrorCodes.PROFILE_NOT_FOUND,
            message: `profile "${c.args.name}" does not exist`,
          })
        }
        const prev = await readAct()
        await writeAct({ ...prev, profile: c.args.name })
        return { profile: c.args.name, previous: prev.profile ?? null }
      },
    })
}
