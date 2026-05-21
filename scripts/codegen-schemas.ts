// scripts/codegen-schemas.ts
//
// Codegens `src/core/generated/{platform,business}_profile.zod.ts` from the
// canonical UCP schemas published at `<specBaseUrl>/<specVersion>/`.
//
// Pipeline:
//   1. Read package.json#ucp.{specVersion, specBaseUrl}; UCP_SPEC_BASE_URL
//      env override wins over package.json
//   2. $RefParser.dereference against entry URL, with a pass-through
//      resolve.http resolver (every URL goes through fetch()).
//   3. Apply T2 injectObjectType()                    — bundle-level, permanent
//   4. Apply T4 openAdditionalProperties()            — bundle-level, permanent
//   5. For each of [platform_profile, business_profile]:
//        jsonSchemaToZod → write to src/core/generated/<branch>.zod.ts
//   6. Stamp each output with a header banner pointing back here
//
// No temporary transforms are active at the current specVersion. The T3 and T5
// patterns (pre-fetch source doc + mutate by name + serve mutated copy through
// a resolve.http short-circuit) were removed once upstream stabilized at this
// version. Reintroduce the same shape if a future temporary fix is needed.
//
// Published artifacts at `<base>/<version>/schemas/...` carry absolute,
// version-prefixed `$id` URLs that match the absolute fetch paths — refs
// resolve under JSON Schema 2020-12 URI semantics with zero transforms.
// (Earlier file-form pipeline needed T1 stripIds() to paper over a source-
// form `$id` vs filesystem-relative `$ref` mismatch; that's gone now.)
//
// Version paths under <base>/<version>/ are frozen-by-convention: BC and
// non-BC fixes both land at a new version path. Temporary-transform self-
// destruct triggers (when reintroduced) are therefore engineer-driven (bump
// specVersion), never spontaneous.
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

  console.log(`▸ spec version: ${specVersion}`)
  console.log(`▸ spec base:    ${specBaseUrl}`)
  console.log(`▸ entry:        ${entryUrl}`)

  // No temporary transforms applied at the current specVersion. Both T3
  // (platform_schema endpoint) and T5 (business_schema payment_handlers) were
  // removed once the upstream picture stabilized at this version. If a future
  // temporary fix is needed, re-introduce the pre-fetch + resolver short-
  // circuit pattern: fetch the source document, mutate by name, and serve the
  // mutated copy back through a custom resolve.http reader.
  const dereffed = (await $RefParser.dereference(entryUrl, {
    resolve: {
      http: {
        order: 1,
        canRead: /^https?:/i,
        async read(file: { url: string }) {
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

  await mkdir(OUT_DIR, { recursive: true })
  const transformsApplied = ['T2 injectObjectType', 'T4 openAdditionalProperties']

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

function banner(entryUrl: string, specVersion: string, transforms: string[]): string {
  return `// AUTOGENERATED — DO NOT EDIT.
//
// Generated by scripts/codegen-schemas.ts from UCP spec at:
//   url     ${entryUrl}
//   version ${specVersion}
//
// Transforms applied:
${transforms.map((t) => `//   - ${t}`).join('\n')}
//
// To regenerate:  pnpm gen:schemas
// CI drift gate:  any uncommitted change here fails the build.
`
}
