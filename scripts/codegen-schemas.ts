// scripts/codegen-schemas.ts
//
// Codegens the per-release spec artifacts under `src/core/generated/<version>/`
// for every release listed in package.json#ucp.releases:
//
//   business_profile.zod.ts   zod schema for the business profile branch
//   platform_profile.zod.ts   zod schema for the platform profile branch
//   reverse_domain.ts         that release's reverse_domain_name pattern
//   agent_profile.ts          VERBATIM snapshot of the published Shopify
//                             agent profile this CLI presents as its identity
//
// The hand-written registry `src/core/releases.ts` imports these per release.
//
// Pipeline (per release):
//   1. Read package.json#ucp.{releases, specBaseUrl}; UCP_SPEC_BASE_URL
//      env override wins over package.json
//   2. Look up the release's codegen config (entry path and `$defs` names
//      moved between releases — see RELEASE_CONFIGS)
//   3. $RefParser.dereference against the entry URL, with a pass-through
//      resolve.http resolver (every URL goes through fetch()).
//   4. Apply T2 injectObjectType()                    — bundle-level, permanent
//   5. Apply T4 openAdditionalProperties()            — bundle-level, permanent
//   6. For each of [platform, business]:
//        jsonSchemaToZod → write to src/core/generated/<version>/<branch>.zod.ts
//   7. Fetch the release's reverse_domain_name.json and emit its `pattern`
//      so it is never hand-copied into src again
//   8. Fetch the published agent profile, validate it against the freshly
//      generated platform schema, and emit it byte-for-byte
//   9. Stamp each output with a header banner pointing back here
//
// Both transforms are permanent and bundle-level, so they apply uniformly to
// every release. (Historical note: the pre-#50 2026-04-08 generation ran with
// T2 only — T4 landed later. T4 is a pure relaxation, `additionalProperties`
// absent ⇒ open per JSON Schema 2020-12, so applying it retroactively to
// 2026-04-08 restores the spec's intent rather than changing it.)
//
// No temporary transforms are active at the current releases. The T3 and T5
// patterns (pre-fetch source doc + mutate by name + serve mutated copy through
// a resolve.http short-circuit) were removed once upstream stabilized. If a
// future temporary fix is needed, reintroduce the same shape — scoped to one
// release's config.
//
// Published artifacts at `<base>/<version>/schemas/...` carry absolute,
// version-prefixed `$id` URLs that match the absolute fetch paths — refs
// resolve under JSON Schema 2020-12 URI semantics with zero transforms.
// (Earlier file-form pipeline needed T1 stripIds() to paper over a source-
// form `$id` vs filesystem-relative `$ref` mismatch; that's gone now.)
//
// Version paths under <base>/<version>/ are frozen-by-convention: BC and
// non-BC fixes both land at a new version path. Temporary-transform self-
// destruct triggers (when reintroduced) are therefore engineer-driven (edit
// the release config), never spontaneous.
//
// Run via: pnpm gen:schemas
// CI drift gate: `pnpm gen:schemas && git diff --exit-code src/core/generated/`

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import $RefParser from '@apidevtools/json-schema-ref-parser'
import { jsonSchemaToZod } from 'json-schema-to-zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const OUT_ROOT = resolve(REPO_ROOT, 'src/core/generated')

type Manifest = {
  ucp: {
    releases: string[]
    specBaseUrl: string
  }
}

type JsonNode = unknown

// Per-release codegen config. Everything version-specific about how a release
// publishes its schemas lives here; package.json#ucp.releases decides WHICH
// releases are generated, this table decides HOW.
//
// The `$defs` names are the trap this table exists for: 2026-08-25 renamed
// the profile branches from `*_profile` to `*_schema` and moved the entry
// document from `schemas/discovery/` to `schemas/`. Generated filenames stay
// `{platform,business}_profile` across releases so importers never churn when
// the spec renames its internals.
type ReleaseConfig = {
  /** Profile entry document, relative to `<base>/<version>/`. */
  entryPath: string
  /** `$defs` key of the platform branch inside the entry document. */
  platformDef: string
  /** `$defs` key of the business branch inside the entry document. */
  businessDef: string
  /** `reverse_domain_name.json` location, relative to `<base>/<version>/`. */
  reverseDomainPath: string
  /**
   * Published agent profile snapshotted verbatim as this release's default
   * identity. Absolute URL (shopify.dev, not the spec host), so the
   * UCP_SPEC_BASE_URL mirror override deliberately does not apply to it.
   */
  agentProfileUrl: string
}

const RELEASE_CONFIGS: Record<string, ReleaseConfig> = {
  '2026-04-08': {
    entryPath: 'schemas/discovery/profile.json',
    platformDef: 'platform_profile',
    businessDef: 'business_profile',
    reverseDomainPath: 'schemas/shopping/types/reverse_domain_name.json',
    agentProfileUrl:
      'https://shopify.dev/ucp/agent-profiles/2026-04-08/valid-with-capabilities.json',
  },
  '2026-08-25': {
    entryPath: 'schemas/profile.json',
    platformDef: 'platform_schema',
    businessDef: 'business_schema',
    reverseDomainPath: 'schemas/common/types/reverse_domain_name.json',
    agentProfileUrl:
      'https://shopify.dev/ucp/agent-profiles/2026-08-25/valid-with-capabilities.json',
  },
}

const TRANSFORMS_APPLIED = ['T2 injectObjectType', 'T4 openAdditionalProperties']

/** Recursive `$requestConstraints` grammar; stubbed in the resolver (see below). */
const CONSTRAINT_EXPRESSION_RE = /\/common\/types\/constraint_expression\.json$/

main().catch((err) => {
  console.error('codegen-schemas failed:', err)
  process.exit(1)
})

async function main() {
  const pkg: Manifest = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'))
  const releases = pkg.ucp.releases
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error('package.json#ucp.releases must be a non-empty array of spec versions')
  }
  // UCP_SPEC_BASE_URL overrides package.json#ucp.specBaseUrl at runtime —
  // for staging, air-gapped mirrors, or local spec preview.
  const specBaseUrl = (process.env.UCP_SPEC_BASE_URL ?? pkg.ucp.specBaseUrl).replace(/\/$/, '')

  // Sorted ascending so output order (logs, directory creation) is
  // deterministic regardless of package.json ordering.
  for (const version of [...releases].sort()) {
    const config = RELEASE_CONFIGS[version]
    if (!config) {
      throw new Error(
        `package.json#ucp.releases lists "${version}" but scripts/codegen-schemas.ts has no ` +
          `RELEASE_CONFIGS entry for it — add one (entry path, $defs names, reverse-domain path, ` +
          `agent profile URL).`,
      )
    }
    await generateRelease(version, config, specBaseUrl)
  }
}

async function generateRelease(version: string, config: ReleaseConfig, specBaseUrl: string) {
  const entryUrl = `${specBaseUrl}/${version}/${config.entryPath}`
  const outDir = resolve(OUT_ROOT, version)

  console.log(`▸ release:      ${version}`)
  console.log(`▸ spec base:    ${specBaseUrl}`)
  console.log(`▸ entry:        ${entryUrl}`)

  const dereffed = (await $RefParser.dereference(entryUrl, {
    resolve: {
      http: {
        order: 1,
        canRead: /^https?:/i,
        async read(file: { url: string }) {
          // `constraint_expression` (introduced 2026-08-25; no counterpart in
          // 2026-04-08, so this branch never fires there) is a genuinely
          // recursive grammar (constraint_expression -> and/or ->
          // constraint_expression), which `dereference: { circular: false }`
          // would reject. It IS reachable from an emitted branch:
          // business_schema -> payment_handlers -> available_instruments[]
          // .constraints $refs it, so the stub lands in generated output as an
          // open object. That shallow leaf is deliberate: the CLI treats
          // constraint expressions as opaque business-owned data, and an open
          // stub beats relaxing `circular` for the whole tree.
          if (CONSTRAINT_EXPRESSION_RE.test(file.url)) {
            return JSON.stringify({ type: 'object', additionalProperties: true })
          }
          return await fetchText(file.url)
        },
      },
    },
    // circular: false — silent half-deref bundles hide real spec bugs. If the
    // spec ever introduces a genuine cycle we want a loud failure, not z.any()
    // soup deep inside the generated tree.
    dereference: { circular: false },
  })) as Record<string, JsonNode>

  injectObjectType(dereffed) // T2
  openAdditionalProperties(dereffed) // T4

  await mkdir(outDir, { recursive: true })

  // `def` is the `$defs` key inside the spec's profile entry document (renamed
  // from `*_profile` to `*_schema` in 2026-08-25); `out` is the generated
  // filename, kept stable so importers never churn when the spec renames its
  // internals.
  const branches = [
    {
      def: config.platformDef,
      out: 'platform_profile',
      export: 'platformProfileSchema',
      type: 'PlatformProfile',
    },
    {
      def: config.businessDef,
      out: 'business_profile',
      export: 'businessProfileSchema',
      type: 'BusinessProfile',
    },
  ] as const

  for (const branch of branches) {
    const subSchema = (dereffed.$defs as Record<string, JsonNode>)?.[branch.def]
    if (!subSchema) {
      throw new Error(`Spec ${version} is missing #/$defs/${branch.def} — schema layout changed?`)
    }
    const body = jsonSchemaToZod(subSchema, {
      module: 'esm',
      name: branch.export,
      type: branch.type,
    })
    const out = resolve(outDir, `${branch.out}.zod.ts`)
    await writeFile(out, `${banner(entryUrl, version, TRANSFORMS_APPLIED)}\n${body}\n`)
    console.log(`✓ ${version}/${branch.out} → ${out} (${body.length.toLocaleString()} bytes)`)
  }

  await generateReverseDomainPattern(version, config, specBaseUrl, outDir)
  await generateAgentProfileSnapshot(version, config, outDir)
}

// Emits the release's `reverse_domain_name` pattern as generated code so it is
// never hand-copied again. The pattern CHANGED between releases (2026-04-08
// disallows hyphens and digit-leading segments; 2026-08-25 allows both), so
// per-release emission is load-bearing, not ceremony.
async function generateReverseDomainPattern(
  version: string,
  config: ReleaseConfig,
  specBaseUrl: string,
  outDir: string,
) {
  const url = `${specBaseUrl}/${version}/${config.reverseDomainPath}`
  const doc = JSON.parse(await fetchText(url)) as { type?: unknown; pattern?: unknown }
  if (doc.type !== 'string' || typeof doc.pattern !== 'string') {
    throw new Error(`${url} is not a { type: "string", pattern: ... } schema — layout changed?`)
  }
  // Compile check at codegen time: a pattern the runtime cannot compile must
  // fail here, not at first CLI use.
  new RegExp(doc.pattern)

  const body = `${banner(url, version, [])}
// Consumed through the release registry: \`isReverseDnsKey\` in
// src/core/operation.ts validates caller-supplied extension keys against
// \`RELEASES[<negotiated version>].reverseDomainPattern\`. Never hand-copy this
// pattern — the grammar is not stable across releases (2026-04-08 is strictly
// narrower: no hyphens, no digit-leading segments), so one release's regex is
// wrong for the other.

/** \`reverse_domain_name\` pattern for UCP ${version}, verbatim from the spec. */
export const reverseDomainPattern: RegExp = new RegExp(${JSON.stringify(doc.pattern)})
`
  const out = resolve(outDir, 'reverse_domain.ts')
  await writeFile(out, body)
  console.log(`✓ ${version}/reverse_domain → ${out}`)
}

// Emits a VERBATIM snapshot of the published agent profile. Byte-faithful by
// design: on the default path `meta.profile_url` points at this same published
// URL, so the hosted document is the CLI's identity and the local copy must
// match what the URL serves — otherwise `ucp doctor`'s drift diff reports
// phantom drift on every clean install. Because the snapshot participates in
// the CI drift gate, an upstream edit to the published profile surfaces as a
// diff at the next regen instead of silently desyncing.
async function generateAgentProfileSnapshot(
  version: string,
  config: ReleaseConfig,
  outDir: string,
) {
  const text = await fetchText(config.agentProfileUrl)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `Published agent profile at ${config.agentProfileUrl} is not valid JSON: ${String(err)}`,
    )
  }

  // Validate the snapshot against the platform schema generated moments ago —
  // the exact artifact runtime consumers use (same transforms, same zod). This
  // backs the `as PlatformProfile` the registry applies when parsing the
  // snapshot, and catches Shopify publishing a profile its own spec rejects.
  const schemaModule = pathToFileURL(resolve(outDir, 'platform_profile.zod.ts')).href
  const { platformProfileSchema } = (await import(schemaModule)) as {
    platformProfileSchema: { safeParse(input: unknown): { success: boolean; error?: unknown } }
  }
  const result = platformProfileSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `Published agent profile at ${config.agentProfileUrl} does not validate against the ` +
        `generated ${version} platform profile schema:\n${JSON.stringify(result.error, null, 2)}`,
    )
  }

  const body = `${banner(config.agentProfileUrl, version, [])}
/** Source URL of the published agent profile snapshotted below. */
export const agentProfileUrl: string = ${JSON.stringify(config.agentProfileUrl)}

/**
 * Verbatim response body of \`agentProfileUrl\` at codegen time — byte-for-byte,
 * including whitespace. Do not filter, reorder, or hand-tune: this document is
 * the identity the CLI presents, and byte equality with the published URL is
 * what keeps profile-drift diffing honest.
 */
export const agentProfileJson: string = ${JSON.stringify(text)}
`
  const out = resolve(outDir, 'agent_profile.ts')
  await writeFile(out, body)
  console.log(
    `✓ ${version}/agent_profile → ${out} (${text.length.toLocaleString()} bytes verbatim)`,
  )
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────
//
// fetchText wraps network errors with a friendly message naming the URL and
// the UCP_SPEC_BASE_URL override. Without this, contributors on flaky
// networks blame us instead of their connection.

async function fetchText(url: string): Promise<string> {
  let r: Response
  try {
    r = await fetch(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to fetch UCP spec at ${url}: ${msg}\nCheck network, or override with UCP_SPEC_BASE_URL=<mirror>.`,
    )
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`)
  return await r.text()
}

// ─── transforms ───────────────────────────────────────────────────────────

// T2 — injectObjectType (permanent)
//
// Walk the dereferenced bundle; on any node with `properties` but no `type`,
// inject `type: "object"`. Without this, json-schema-to-zod v2.8 collapses
// allOf override branches (which use `{ properties: { ucp: ... } }` to add
// per-flavor constraints without restating the type) into z.any() and
// erases the platform/business shape distinction entirely.
function injectObjectType(node: JsonNode): void {
  if (Array.isArray(node)) {
    for (const child of node) injectObjectType(child)
    return
  }
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>
    if (
      n.properties !== undefined &&
      n.type === undefined &&
      !('$ref' in n) &&
      !('oneOf' in n) &&
      !('anyOf' in n)
    ) {
      n.type = 'object'
    }
    for (const value of Object.values(n)) injectObjectType(value)
  }
}

// T4 — openAdditionalProperties (permanent)
//
// UCP schemas are intentionally open per PROTOCOL §12 (forward-compat:
// future protocol versions add fields, vendors add namespaced extensions
// like dev.ucp.shopping.discount, capability extensions ride alongside
// known fields). The canonical spec relies on JSON Schema 2020-12's
// default behavior — `additionalProperties` absent ⇒ extras allowed.
//
// json-schema-to-zod doesn't carry that intent across: when the source
// schema omits `additionalProperties`, it emits a plain `z.object({...})`,
// and zod's default is to STRIP unknown keys on parse. Net effect: every
// business extension and every future-spec field would silently disappear
// at the parse boundary — re-introducing exactly the methodology drift the
// codegen pipeline was built to eliminate.
//
// T4 walks the dereferenced bundle and, on every node with `properties`
// but no explicit `additionalProperties`, sets `additionalProperties: true`.
// json-schema-to-zod renders that as `.catchall(z.any())`, which preserves
// extras at runtime while keeping known fields type-checked. Nodes with an
// explicit `additionalProperties: false` (closed by intent) or a typed
// catchall (`additionalProperties: { type: ... }`) are left untouched —
// future spec tightening is respected.
function openAdditionalProperties(node: JsonNode): void {
  if (Array.isArray(node)) {
    for (const child of node) openAdditionalProperties(child)
    return
  }
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>
    if (n.properties !== undefined && n.additionalProperties === undefined && !('$ref' in n)) {
      n.additionalProperties = true
    }
    for (const value of Object.values(n)) openAdditionalProperties(value)
  }
}

// ─── output banner ────────────────────────────────────────────────────────

function banner(sourceUrl: string, specVersion: string, transforms: string[]): string {
  const transformLines =
    transforms.length > 0
      ? transforms.map((t) => `//   - ${t}`).join('\n')
      : '//   (none — verbatim source)'
  return `// AUTOGENERATED — DO NOT EDIT.
//
// Generated by scripts/codegen-schemas.ts from UCP spec at:
//   url     ${sourceUrl}
//   version ${specVersion}
//
// Transforms applied:
${transformLines}
//
// To regenerate:  pnpm gen:schemas
// CI drift gate:  any uncommitted change here fails the build.
`
}
