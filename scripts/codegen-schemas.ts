// scripts/codegen-schemas.ts
//
// Codegens `src/core/generated/{platform,business}_profile.zod.ts` from the
// canonical UCP schemas published at `<specBaseUrl>/<specVersion>/`.
//
// Pipeline:
//   1. Read package.json#ucp.{specVersion, specBaseUrl}; UCP_SPEC_BASE_URL
//      env override wins over package.json
//   2. Pre-fetch ucp.json; apply T5 in-memory (TEMPORARY — see below)
//   3. $RefParser.dereference against entry URL, with a custom resolve.http
//      resolver that serves the mutated ucp.json from memory and passes every
//      other URL through to fetch()
//   4. Apply T2 injectObjectType()                    — bundle-level, permanent
//   5. Apply T4 openAdditionalProperties()            — bundle-level, permanent
//   6. For each of [platform_profile, business_profile]:
//        jsonSchemaToZod → write to src/core/generated/<branch>.zod.ts
//   7. Stamp each output with a header banner pointing back here
//
// Published artifacts at `<base>/<version>/schemas/...` carry absolute,
// version-prefixed `$id` URLs that match the absolute fetch paths — refs
// resolve under JSON Schema 2020-12 URI semantics with zero transforms.
// (Earlier file-form pipeline needed T1 stripIds() to paper over a source-
// form `$id` vs filesystem-relative `$ref` mismatch; that's gone now.)
//
// Why T5 runs against its source document before dereference: after deref,
// named $defs markers are lost and look-alike branches become hard to
// disambiguate. Mutating the source document by name beforehand is robust
// and obvious. (T3 was the sibling pattern for platform_schema; removed
// once the upstream spec fix landed at this specVersion.)
//
// Version paths under <base>/<version>/ are frozen-by-convention: BC and
// non-BC fixes both land at a new version path. T5's self-destruct trigger
// is therefore engineer-driven (bump specVersion), never spontaneous.
//
// Run via: pnpm gen:schemas
// CI drift gate: `pnpm gen:schemas && git diff --exit-code src/core/generated/`

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import $RefParser from '@apidevtools/json-schema-ref-parser'
import { jsonSchemaToZod } from 'json-schema-to-zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..')
const OUT_DIR = resolve(REPO_ROOT, 'src/core/generated')

type Manifest = {
  ucp: {
    specVersion: string
    specBaseUrl: string
  }
}

type JsonNode = unknown

const BRANCHES = [
  { def: 'platform_profile', export: 'platformProfileSchema', type: 'PlatformProfile' },
  { def: 'business_profile', export: 'businessProfileSchema', type: 'BusinessProfile' },
] as const

main().catch((err) => {
  console.error('codegen-schemas failed:', err)
  process.exit(1)
})

async function main() {
  const pkg: Manifest = JSON.parse(await readFile(resolve(REPO_ROOT, 'package.json'), 'utf8'))
  const { specVersion } = pkg.ucp
  // UCP_SPEC_BASE_URL overrides package.json#ucp.specBaseUrl at runtime —
  // for staging, air-gapped mirrors, or local spec preview.
  const specBaseUrl = (process.env.UCP_SPEC_BASE_URL ?? pkg.ucp.specBaseUrl).replace(/\/$/, '')

  const entryUrl = `${specBaseUrl}/${specVersion}/schemas/discovery/profile.json`
  const ucpUrl = `${specBaseUrl}/${specVersion}/schemas/ucp.json`

  console.log(`▸ spec version: ${specVersion}`)
  console.log(`▸ spec base:    ${specBaseUrl}`)
  console.log(`▸ entry:        ${entryUrl}`)

  // T5 (TEMPORARY): pre-fetch the ucp.json document and mutate in memory.
  // The custom resolver below serves the mutated copy to ref-parser when it
  // asks for ucpUrl; everything else passes through to fetch().
  //
  // T3 was a sibling transform against service.json's platform_schema; the
  // upstream spec fix landed at this specVersion, the drift gate caught it,
  // and the transform was removed per its self-destruct checklist. If a
  // future temporary transform on service.json is needed, re-introduce the
  // pre-fetch + resolver short-circuit alongside it.
  const ucpDoc = await fetchJson(ucpUrl)
  const t5Touched = relaxBusinessPaymentHandlersRequirementInPlace(ucpDoc)
  if (t5Touched === 0) throw t5SelfDestructError()

  const dereffed = (await $RefParser.dereference(entryUrl, {
    resolve: {
      http: {
        order: 1,
        canRead: /^https?:/i,
        async read(file: { url: string }) {
          if (file.url === ucpUrl) return JSON.stringify(ucpDoc)
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

  console.warn(
    `⚠ T5 (TEMPORARY): relaxed business_schema payment_handlers requirement on ${t5Touched} branch(es). Remove this transform once the spec PR making payment_handlers optional on business_schema lands and specVersion is bumped to that version.`,
  )

  await mkdir(OUT_DIR, { recursive: true })
  const transformsApplied = [
    'T2 injectObjectType',
    'T4 openAdditionalProperties',
    'T5 relaxBusinessPaymentHandlersRequirement (TEMPORARY)',
  ]

  for (const branch of BRANCHES) {
    const subSchema = (dereffed.$defs as Record<string, JsonNode>)?.[branch.def]
    if (!subSchema) {
      throw new Error(`Spec is missing #/$defs/${branch.def} — schema layout changed?`)
    }
    const body = jsonSchemaToZod(subSchema, {
      module: 'esm',
      name: branch.export,
      type: branch.type,
    })
    const out = resolve(OUT_DIR, `${branch.def}.zod.ts`)
    await writeFile(out, `${banner(entryUrl, specVersion, transformsApplied)}\n${body}\n`)
    console.log(`✓ ${branch.def} → ${out} (${body.length.toLocaleString()} bytes)`)
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────
//
// Both fetchText and fetchJson wrap network errors with a friendly message
// naming the URL and the UCP_SPEC_BASE_URL override. Without this, contributors
// on flaky networks blame us instead of their connection.

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

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fetchText(url))
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

// T5 — relaxBusinessPaymentHandlersRequirementInPlace ⚠ TEMPORARY ⚠
//
// The canonical ucp.json#/$defs/business_schema requires `payment_handlers`
// on every business profile. That rejects legitimate read-only business
// profiles (browse/search-only catalogs, lookup endpoints, content-only
// integrations) that have no checkout flow to declare. Concrete example:
// catalog.shopify.com publishes a search/lookup business profile with no
// payment_handlers and is rejected by our discovery validation.
//
// This transform reaches into the in-memory ucp.json document, finds the
// business_schema allOf piece that carries the `required` array, and
// removes `payment_handlers`. The `services` requirement is preserved —
// a business with no services declared is not useful. Operating on
// ucp.json by name BEFORE dereference is robust: post-dereference, the
// business_schema/platform_schema marker is lost and per-flavor required
// arrays become hard to disambiguate.
//
// REMOVE THIS TRANSFORM once the spec PR making payment_handlers optional
// on business_schema lands at a published specVersion and we bump to it.
// The drift-gate CI step will catch the resulting regen.
function relaxBusinessPaymentHandlersRequirementInPlace(obj: Record<string, unknown>): number {
  const businessSchema = (obj?.$defs as Record<string, unknown> | undefined)?.business_schema
  if (!isObject(businessSchema)) {
    throw new Error('T5: ucp.json#/$defs/business_schema not found — schema layout changed?')
  }
  let touched = 0
  for (const piece of asArray(businessSchema.allOf)) {
    if (!isObject(piece)) continue
    if (!Array.isArray(piece.required)) continue
    const required: unknown[] = piece.required
    const before = required.length
    const after = required.filter((r) => r !== 'payment_handlers')
    piece.required = after
    if (after.length < before) touched++
  }
  return touched
}

function t5SelfDestructError(): Error {
  return new Error(
    'T5 (relaxBusinessPaymentHandlersRequirementInPlace): expected to relax 1 business_schema ' +
      'allOf branch but matched 0. Likely the upstream spec fix has landed at this specVersion. ' +
      'To remove this transform:\n' +
      '  1. scripts/codegen-schemas.ts: delete relaxBusinessPaymentHandlersRequirementInPlace()\n' +
      '     and its call site in main() (look for `// T5`).\n' +
      '  2. scripts/codegen-schemas.ts: simplify the resolve.http resolver — remove the\n' +
      '     `if (file.url === ucpUrl)` short-circuit; drop the ucpDoc pre-fetch.\n' +
      '  3. scripts/codegen-schemas.ts: drop the T5 entry from transformsApplied[] and the\n' +
      '     t5Touched warn log; drop t5SelfDestructError().\n' +
      '  4. scripts/codegen-schemas.ts: drop the T5 line in banner()/T5 notice block.\n' +
      '  5. Re-run `pnpm gen:schemas` and commit the updated src/core/generated/.',
  )
}

function asArray(x: unknown): unknown[] {
  return Array.isArray(x) ? x : []
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

// ─── output banner ────────────────────────────────────────────────────────

function banner(entryUrl: string, specVersion: string, transforms: string[]): string {
  const temporary: string[] = []
  if (transforms.some((t) => t.startsWith('T5'))) {
    temporary.push(
      '//   - T5 relaxBusinessPaymentHandlersRequirement — pending upstream fix making\n//     payment_handlers optional on business_schema (read-only catalogs do not have one).',
    )
  }
  const tempNotice = temporary.length
    ? `//\n// ⚠ INCLUDES TEMPORARY TRANSFORM(S):\n${temporary.join('\n')}\n`
    : ''
  return `// AUTOGENERATED — DO NOT EDIT.
//
// Generated by scripts/codegen-schemas.ts from UCP spec at:
//   url     ${entryUrl}
//   version ${specVersion}
//
// Transforms applied:
${transforms.map((t) => `//   - ${t}`).join('\n')}
${tempNotice}//
// To regenerate:  pnpm gen:schemas
// CI drift gate:  any uncommitted change here fails the build.
`
}
