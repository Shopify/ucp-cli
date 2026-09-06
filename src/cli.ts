// CLI entrypoint.
//
// The top-level `Cli` is intentionally real even before project-specific
// commands are registered: incur provides built-ins such as --version,
// --help, --llms, --mcp, `mcp add`, and `skills`. Integration tests should
// exercise this dispatcher directly so output shape stays faithful.

import { Cli, middleware, z } from 'incur'

import { buildCta } from './cli/cta.js'
import { type DoctorDeps, runDoctor } from './cli/doctor.js'
import { buildOperationInput } from './cli/input.js'
import { buildProfileCli, type ProfileCliDependencies } from './cli/profile.js'
import { buildProfileSwitchCta, localProfilesSpeaking } from './cli/profile-hint.js'
import { resolveSession } from './cli/session.js'
import { syncSkillsWithCleanup } from './cli/skills-sync.js'
import { runUse, type UseDeps } from './cli/use.js'
import { applyView, resolveView, type ViewState } from './cli/view.js'
import { type DiscoveredBusiness, discover } from './core/discover.js'
import {
  buildEscalationPayload,
  type EscalationHook,
  type EscalationPayload,
  isEscalationEnvelope,
  resolveEscalationHook,
  runEscalationHook,
} from './core/escalation.js'
import { canonicalizeOrigin, type HeaderMap, resolveHeaders } from './core/headers.js'
import { isDryRunPreview } from './core/operation.js'
import { listProfiles, readUserProfile } from './core/profile-store.js'
import { describeProxyState } from './core/proxy.js'
import { SUPPORTED_VERSIONS } from './core/releases.js'
import { acceptsHttpsUrl, parseHttpsUrl } from './core/url.js'
import { setVerboseWriter, vlog } from './core/verbose.js'
import { ErrorCodes, UcpError } from './lib/errors.js'
import { omitUndefined } from './lib/omit-undefined.js'
import type { CtaBlock, Transport } from './lib/types.js'
import {
  cancelCart,
  cancelCheckout,
  completeCheckout,
  createCart,
  createCheckout,
  getCart,
  getCheckout,
  getOrder,
  getProduct,
  lookupCatalog,
  searchCatalog,
  updateCart,
  updateCheckout,
} from './services/shopping.js'

// Description and skills-suggestions are constants so the bin-entry
// `skills add` interceptor can pass the same values to syncSkillsWithCleanup
// that Cli.create stamps onto the live CLI. Keeping them in lockstep avoids
// cosmetic drift between `ucp --help` and the post-sync printout.
const CLI_DESCRIPTION = 'Reference CLI + MCP server for the Universal Commerce Protocol'
const SKILLS_SUGGESTIONS: string[] = [
  'Help me find running shoes for marathon training under $150',
  'Search <shop-url> for noise-canceling headphones and walk me through buying a pair',
  'What operations does <shop-url> support over UCP?',
]
/**
 * What `ucp --version` prints: `ucp 0.7.0 (UCP 2026-04-08, 2026-08-25)`.
 *
 * The parenthetical is the SUPPORTED RELEASES, derived from the release
 * registry — never hardcoded, so adding or dropping a release cannot leave
 * this line lying. It matters because the installed CLI does not determine
 * which protocol version is spoken (the active agent profile does): the only
 * version fact a build can state is which releases it supports.
 */
export function versionLine(): string {
  return `ucp ${__CLI_VERSION__} (UCP ${SUPPORTED_VERSIONS.join(', ')})`
}

/**
 * True when `argv` is a root `--version` query rather than a command-local
 * `--version` VALUE (`ucp profile init --version 2026-04-08`).
 *
 * Mirrors incur's own rule (`Cli.js` extractBuiltinFlags): `--version` is the
 * builtin only when the next token is absent or starts with `-`. `--help`
 * wins over `--version` there too, so it wins here.
 */
export function isRootVersionInvocation(argv: readonly string[]): boolean {
  if (argv.includes('--help') || argv.includes('-h')) return false
  return argv.some(
    (token, i) =>
      token === '--version' && (argv[i + 1] === undefined || argv[i + 1]?.startsWith('-') === true),
  )
}

const CREATE_CHECKOUT_TOOL_NAME = 'create_checkout'
const CHECKOUT_TOOL_NAMES = new Set([
  CREATE_CHECKOUT_TOOL_NAME,
  'get_checkout',
  'update_checkout',
  'complete_checkout',
  'cancel_checkout',
])

// Test injections target the call signature only — metadata
// (capability/toolName/opName, used by --input-schema and --view aliases) is
// copied from the production helper at wire-up time. Keeps stubs as plain async
// functions while still letting schema/view paths introspect against a
// stub-replaced helper.
export type ShoppingHelperDep = (
  businessUrl: string,
  input: Record<string, unknown>,
  options: {
    force: boolean
    profileUrl: string
    /** Local profile name, for messages (see DiscoverOptions.profileName). */
    profileName?: string
    dryRun?: boolean
    /** Resolved outbound HTTP headers; see {@link resolveHeaders}. */
    headers?: Record<string, string>
    /** Internal-only side-channel; see CallOperationCallerOptions._onDiscover. */
    _onDiscover?: (discovered: DiscoveredBusiness) => void
  },
) => Promise<unknown>

export interface UcpCliDependencies {
  discover?: typeof discover
  resolveSession?: typeof resolveSession
  searchCatalog?: ShoppingHelperDep
  lookupCatalog?: ShoppingHelperDep
  getProduct?: ShoppingHelperDep
  createCart?: ShoppingHelperDep
  getCart?: ShoppingHelperDep
  updateCart?: ShoppingHelperDep
  cancelCart?: ShoppingHelperDep
  createCheckout?: ShoppingHelperDep
  getCheckout?: ShoppingHelperDep
  updateCheckout?: ShoppingHelperDep
  completeCheckout?: ShoppingHelperDep
  cancelCheckout?: ShoppingHelperDep
  getOrder?: ShoppingHelperDep
  profile?: ProfileCliDependencies
  use?: UseDeps
  doctor?: DoctorDeps
  /**
   * When true, MCP-only safety policy applies: session resolution ignores
   * active.yaml, and escalation hooks cannot spawn subprocesses or browsers.
   * Set at the bin entrypoint from `process.argv.includes('--mcp')`; test
   * injection lets specs exercise both branches without a stdio server.
   */
  inMcpMode?: boolean
  /**
   * Override hook resolution + execution (test injection). Defaults to the
   * production resolveEscalationHook + runEscalationHook from src/core/escalation.
   * Returning `undefined` from `resolveHook` short-circuits without spawning.
   */
  resolveEscalationHook?: typeof resolveEscalationHook
  runEscalationHook?: typeof runEscalationHook
}

export function createUcpCli(deps: UcpCliDependencies = {}) {
  const inMcpMode = deps.inMcpMode === true
  const discoverImpl = deps.discover ?? discover
  const resolveSessionBase = deps.resolveSession ?? resolveSession
  // An MCP server can multiplex unrelated conversations. Never let one
  // conversation inherit the process user's active.yaml routing state, or a
  // local `ucp use` can silently retarget another conversation's operation.
  // Applied once here so every dispatch path inherits it.
  const resolveSessionImpl: typeof resolveSession = (options = {}) =>
    resolveSessionBase(inMcpMode ? { ...options, inMcpMode: true } : options)
  const searchCatalogImpl = withMeta(deps.searchCatalog, searchCatalog)
  const lookupCatalogImpl = withMeta(deps.lookupCatalog, lookupCatalog)
  const getProductImpl = withMeta(deps.getProduct, getProduct)
  const createCartImpl = withMeta(deps.createCart, createCart)
  const getCartImpl = withMeta(deps.getCart, getCart)
  const updateCartImpl = withMeta(deps.updateCart, updateCart)
  const cancelCartImpl = withMeta(deps.cancelCart, cancelCart)
  const createCheckoutImpl = withMeta(deps.createCheckout, createCheckout)
  const getCheckoutImpl = withMeta(deps.getCheckout, getCheckout)
  const updateCheckoutImpl = withMeta(deps.updateCheckout, updateCheckout)
  const completeCheckoutImpl = withMeta(deps.completeCheckout, completeCheckout)
  const cancelCheckoutImpl = withMeta(deps.cancelCheckout, cancelCheckout)
  const getOrderImpl = withMeta(deps.getOrder, getOrder)
  // Reuses the `profile` command tree's injectable store so tests drive one
  // set of stubs; the hint is read-only and best-effort either way.
  const profileHintDeps = {
    listProfiles: deps.profile?.listProfiles ?? listProfiles,
    readUserProfile: deps.profile?.readUserProfile ?? readUserProfile,
  }

  const cli = Cli.create('ucp', {
    description: CLI_DESCRIPTION,
    format: 'json',
    // Bare semver, deliberately: incur feeds `version` to its update checker
    // (strict-semver `parseVersion`) and to `Mcp.serve` as `serverInfo.version`,
    // so the protocol window cannot ride along here. `runUcpCli` intercepts
    // the root `--version` surface instead — see `versionLine()`.
    version: __CLI_VERSION__,
    mcp: {
      // incur 0.5 defaults MCP tool discovery to 'progressive' (search /
      // inspect / execute meta-tools). Pin 'direct': one tool per command
      // (catalog_search, cart_create, ...) is this CLI's published agent
      // contract, and a dependency default must not rewrite it. Moving to
      // progressive discovery is a product decision with its own migration.
      tools: { discovery: 'direct' },
    },
    sync: {
      // 'skills/*' surfaces every hand-written skills/<dir>/SKILL.md. The bin
      // entrypoint intercepts `skills add` and post-prunes everything else
      // incur emits (auto-generated per-command boilerplate is rarely useful
      // and goes stale on every flag rename). See src/cli/skills-sync.ts for
      // the cleanup contract; remove the interceptor once incur ships a
      // `sync.skipGenerated`-style flag.
      include: ['skills/*'],
      suggestions: SKILLS_SUGGESTIONS,
    },
  })

  // Re-emit SCHEMA_VALIDATION_FAILED via c.error so the recovery cta lands
  // on the wire. Incur's outer catch path strips cta from thrown errors;
  // c.error (sentinel-based) preserves it. The cta points the agent at
  // `--input-schema` so they can fetch the operation input schema and correct
  // their payload without spelunking diagnostic context. `c.command` gives
  // us the exact subcommand path the user ran (e.g. `cart update`), so the
  // suggested command is copy-pasteable verbatim.
  //
  // Other UcpError codes pass through unchanged — incur emits the standard
  // {code, message, retryable} envelope, which is what callers expect today.
  // We only intercept here when there's a known structured recovery path.
  cli.use(
    middleware(async (c, next) => {
      try {
        await next()
      } catch (err) {
        if (err instanceof UcpError && err.code === ErrorCodes.SCHEMA_VALIDATION_FAILED) {
          c.error({
            code: err.code,
            message: err.message,
            cta: {
              description:
                'Re-run with --input-schema to print the operation input schema for --input/--set, then correct the payload values. Unknown plain keys must be listed by the schema or renamed to reverse-DNS extension keys.',
              commands: [
                {
                  command: `${c.displayName} ${c.command} --input-schema`,
                  description: 'print operation input schema for --input/--set',
                },
              ],
            },
          })
          return
        }
        // PROTOCOL_VERSION_INCOMPATIBLE is thrown in core, which cannot see
        // the profile store. Decorate it here with the one remedy that needs
        // local state: "another profile of yours speaks a version they do
        // offer". Deliberately a CTA — `context` is never serialized, so a
        // hint that lived there would not exist for agents reading CLI JSON.
        if (err instanceof UcpError && err.code === ErrorCodes.PROTOCOL_VERSION_INCOMPATIBLE) {
          const cta = buildProfileSwitchCta(
            await localProfilesSpeaking(
              offeredVersions(err.context),
              activeProfileName(err.context),
              profileHintDeps,
            ),
            { command: c.command, displayName: c.displayName },
          )
          if (cta !== undefined) {
            c.error({ code: err.code, message: err.message, cta })
            return
          }
        }
        if (err instanceof UcpError && err.cta !== undefined) {
          c.error({ code: err.code, message: err.message, cta: err.cta })
          return
        }
        throw err
      }
    }),
  )

  cli.command('discover', {
    // `<business>` accepts BOTH a positional arg AND a `--business <url>` flag.
    // The positional form (`ucp discover https://shop.example.com`) reads
    // naturally; the flag form (`ucp discover --business https://shop.example.com`)
    // is symmetric with every state-changing op (`ucp cart get --business=...`)
    // so an agent literate in the rest of the surface doesn't trip on
    // discover's locality. Resolution: explicit flag wins over positional;
    // either falls back through UCP_BUSINESS / active.yaml when both are
    // omitted. We don't error on dual-pass (flag wins) to keep recovery cheap.
    description: 'See what operations a business supports before calling them',
    args: z.object({
      business: z
        .string()
        .optional()
        .describe(
          'Business URL to discover (e.g. https://shop.example.com). Optional — also accepted as `--business <url>`; falls back to UCP_BUSINESS or active.yaml when both are omitted.',
        ),
    }),
    options: z.object({
      business: z
        .string()
        .optional()
        .describe(
          'Business URL to discover (overrides positional arg if both are passed). Symmetric with state-changing ops.',
        ),
      profile: z
        .string()
        .optional()
        .describe('Agent profile name to use for this call (overrides UCP_PROFILE / active.yaml).'),
      profileUrl: z
        .string()
        .optional()
        .describe(
          'Agent profile URL override (overrides UCP_AGENT_PROFILE_URL / profile metadata).',
        ),
      refresh: z
        .boolean()
        .default(false)
        .describe('Bypass the local profile cache and re-fetch from the business.'),
      header: z
        .array(z.string())
        .default([])
        .describe(
          'Add an outbound HTTP header on the discovery + tools/list requests this command makes. Repeatable. Format: --header "Name: Value". Same semantics as on operation commands; required when a merchant gates `/.well-known/ucp` or tools/list behind auth. For bearer auth: --header "Authorization: Bearer $TOKEN".',
        ),
      view: z
        .string()
        .optional()
        .describe(
          'JMESPath projection applied to the whole envelope (the view output REPLACES the envelope). Inline expression or `@<path>` for file. Package-local :<alias> views are available on operation commands, not discover.',
        ),
    }),
    async run(c) {
      if (c.options.view?.startsWith(':') && !inMcpMode) {
        throw new UcpError({
          layer: 'client',
          code: ErrorCodes.INVALID_INPUT,
          message:
            '--view: discover does not support package-local :<alias> views; use an inline expression or @<path>, or pass --view :<alias> to a catalog/cart/checkout/order operation',
        })
      }
      const viewState =
        c.options.view !== undefined && !inMcpMode
          ? await resolveView({ raw: c.options.view })
          : undefined
      const session = await resolveSessionImpl(
        omitUndefined({
          // Flag wins over positional when both are passed. Either falls back
          // through UCP_BUSINESS / active.yaml inside resolveSession.
          business: c.options.business ?? c.args.business,
          profile: c.options.profile,
          profileUrl: c.options.profileUrl,
        }),
      )
      let businessUrl = session.business
      if (businessUrl === undefined) {
        // Catalog fallback rung — bare `discover` is read-only introspection,
        // so routing through `meta.defaults.catalog` when set surfaces the
        // catalog tools instead of a recovery dead-end. State-mutating ops
        // (cart/checkout) gate on bodyKey at prepareOperation; this site has
        // no bodyKey because there's no op family — read-only is the gate.
        const catalogDefault = session.profile.meta?.defaults?.catalog
        if (catalogDefault !== undefined) businessUrl = catalogDefault
      }
      // Bare `discover` is catalog-eligible: the fallback rung above would have
      // fired had `meta.defaults.catalog` been set, so when it didn't, the
      // missing-business CTA is the recovery path.
      if (businessUrl === undefined) return c.error(businessNotResolvedError(inMcpMode))
      const headers = await resolveCallHeaders(c.options, session, businessUrl)
      const discoverResult = await discoverImpl(businessUrl, {
        force: c.options.refresh,
        profileUrl: requireProfileUrl(session.profile.profileUrl),
        // The session knows the local profile NAME; without passing it,
        // PROTOCOL_VERSION_INCOMPATIBLE can only name the URL and cannot
        // suggest `--profile <name>`.
        profileName: session.profile.name,
        headers,
      })
      return c.ok(applyView({ result: discoverResult }, viewState))
    },
  })

  // `--input` (not `--json`) carries the JSON payload because incur reserves
  // `--json` as a global flag. `--set` overlays use JSON Pointer paths so
  // reverse-domain UCP keys (e.g. `signals.dev.ucp.buyer_ip`) survive.
  // `business` is `--business <url>` flag (not positional) so resource ids
  // own the positional slot for `cart get <id>`, `order get <id>`, etc.
  // Resolution chain: flag → UCP_BUSINESS → active.yaml; miss yields
  // BUSINESS_NOT_RESOLVED with a CTA.
  const operationOptions = z.object({
    input: z
      .string()
      .optional()
      .describe('Operation payload as a JSON string. Use --set to override individual fields.'),
    set: z
      .array(z.string())
      .default([])
      .describe(
        'JSON Pointer overlay onto --input, e.g. --set /query=boots. Repeatable. See README for full syntax (RFC 6901).',
      ),
    setString: z
      .array(z.string())
      .default([])
      .describe(
        'Like --set but always treats the value as a string (no JSON parsing). Use for ids that look numeric.',
      ),
    business: z
      .string()
      .optional()
      .describe(
        'Target business URL. Overrides UCP_BUSINESS / active.yaml; required if neither is set. For catalog ops a profile with meta.defaults.catalog supplies the fallback rung, so --business is optional there.',
      ),
    profile: z
      .string()
      .optional()
      .describe('Agent profile name to use for this call (overrides UCP_PROFILE / active.yaml).'),
    profileUrl: z
      .string()
      .optional()
      .describe('Agent profile URL override (overrides UCP_AGENT_PROFILE_URL / profile metadata).'),
    refresh: z
      .boolean()
      .default(false)
      .describe('Bypass the local profile cache and re-fetch from the business.'),
    inputSchema: z
      .boolean()
      .default(false)
      .describe(
        'Print the operation input schema for --input/--set and exit without dispatching. This is the payload schema; use --schema for CLI args/options. Ignores --input/--set because no operation is dispatched.',
      ),
    dryRun: z
      .boolean()
      .default(false)
      .describe(
        'Run discovery + schema validation, then print the exact request that would be sent (including meta.idempotency-key and meta.ucp-agent). Skips network I/O. Useful for debugging SCHEMA_VALIDATION_FAILED, capturing payloads for bug reports, and confirming a mutation before issuing it for real.',
      ),
    onEscalation: z
      .string()
      .optional()
      .describe(
        'Shell command to invoke when a checkout response returns result.status === "requires_escalation". Receives a compact escalation payload as JSON on stdin. Auth errors use CTA handoff guidance and do not fire this hook. Overrides UCP_ON_ESCALATION / config.yaml / hooks file. No-op in --mcp mode.',
      ),
    header: z
      .array(z.string())
      .default([])
      .describe(
        'Add an outbound HTTP header on UCP requests. Repeatable. Format: --header "Name: Value". Overrides headers.json (default + per-business). Reserved framing headers (Content-Type, Accept, Host, etc.) are dropped silently. Values may not contain CR/LF. For bearer auth: --header "Authorization: Bearer $TOKEN".',
      ),
    view: z
      .string()
      .optional()
      .describe(
        'JMESPath projection applied to the whole response envelope. The view output REPLACES the envelope, giving the view file full control over the rendered shape (drop dispatch identity, slim `ucp`, reshape `result`, etc). Accepts an inline expression, `@<path>` to load from a file (UTF-8, `~` expanded), or `:<alias>` for package-local views in the current operation capability (e.g. catalog + :compact => catalog.compact.jmespath from the CLI package skills/ucp/views directory). Composes with --format (project first, render second). CTAs flow through a separate channel and survive any reshape. No-op on --dry-run, --input-schema, --llms, and in --mcp mode. Error envelopes (no `result` field) pass through unchanged so failures are never silently swallowed. See https://jmespath.org for syntax.',
      ),
  })

  // Run-body factory for shopping commands. Every shopping command goes:
  // resolve session → require business → build input → maybe-merge positional
  // id → call helper. Only the helper, id placement, and body wrapper vary;
  // the `args`/`options`/`description` stay inline at the call site so the
  // user-facing command shape remains grep-able. `idPlacement` is undefined
  // for ops without a positional id (search/lookup/create), 'top' for
  // cart/checkout/order ops where id is a sibling of the body, and 'catalog'
  // for get_product where the positional id nests under /catalog on the wire.
  const resolveHookImpl = deps.resolveEscalationHook ?? resolveEscalationHook
  const runHookImpl = deps.runEscalationHook ?? runEscalationHook

  const opRun =
    (helper: ShoppingHelper, idPlacement?: 'top' | 'catalog', bodyKey?: OperationBodyKey) =>
    async (c: ShoppingRunContext) => {
      if (c.options.inputSchema) {
        return inputSchemaOperation(
          c,
          helper,
          resolveSessionImpl,
          discoverImpl,
          idPlacement,
          bodyKey,
          inMcpMode,
        )
      }
      // Resolve --view BEFORE id check + dispatch so a typo'd projection
      // surfaces an INVALID_INPUT immediately — not after the agent has
      // copy-pasted an id and waited on a network round-trip. No-op in MCP
      // mode (response goes to the agent as structured data, not for human
      // rendering); the flag is still accepted by the parser so MCP clients
      // that pass it inadvertently don't error.
      let viewState: ViewState | undefined
      if (c.options.view !== undefined && !inMcpMode) {
        viewState = await resolveView({ raw: c.options.view, capability: helper.opName })
      }
      // Dispatch path: id required when the op has a positional id slot.
      // Schema makes it optional so --input-schema works without a dummy;
      // we re-enforce here with a clear error rather than letting the
      // operation proceed with a stripped id.
      if (idPlacement !== undefined && c.args.id === undefined) {
        return c.error({
          code: ErrorCodes.INVALID_INPUT,
          message: `${helper.toolName} requires a positional id; pass it as the first argument`,
        })
      }
      const prep = await prepareOperation(c, resolveSessionImpl, bodyKey, inMcpMode)
      if (!prep.ok) return c.error(prep.error)
      const wrapped = wrapOperationInput(prep.input, bodyKey)
      const merged = mergeId(wrapped, c.args.id, idPlacement)
      const headers = await resolveCallHeaders(
        c.options,
        { profile: { name: prep.profileName } },
        prep.business,
      )
      // Capture the trusted negotiated view via the internal side-channel.
      // Filled by `callOperation` after `discover()` resolves (BEFORE any
      // OPERATION_NOT_OFFERED throw), so CTAs on transport-layer failures
      // still have advertised-capability context. The intersection with the
      // active profile's capability set happens at the CTA boundary — this
      // keeps the side-channel a pure pass-through of the typed discover result.
      let discovered: DiscoveredBusiness | undefined
      const result = await helper(prep.business, merged, {
        force: prep.force,
        profileUrl: prep.profileUrl,
        profileName: prep.profileName,
        headers,
        ...(c.options.dryRun ? { dryRun: true } : {}),
        _onDiscover: (d) => {
          discovered = d
        },
      })
      // Dry-run short-circuits the regular envelope: no escalation/CTA
      // post-processing, since no business response exists. The preview is
      // the payload; agents read root `endpoint`/`transport`/`business`
      // (dispatchIdentity, canonical) and `result.arguments` (post meta
      // injection) to confirm what would have been sent. No CTA on the
      // envelope: incur strips CTA blocks with empty `commands`, and the
      // only honest next step is the same command minus --dry-run. The
      // explanation lives on `result.note` so it travels with the value.
      if (c.options.dryRun && isDryRunPreview(result)) {
        return c.ok({ ...dispatchIdentity(prep.business, discovered, helper), result })
      }
      // Escalation is a normal UCP protocol response — `requires_escalation`
      // is a checkout STATUS VALUE, not an error. Both branches surface
      // status:ok with the full checkout object; only the CTA differs, and
      // the dispatcher in cli/cta.ts decides which builder to invoke.
      const isEscalation = CHECKOUT_TOOL_NAMES.has(helper.toolName) && isEscalationEnvelope(result)
      if (isEscalation) {
        const payload = buildEscalationPayload(result, {
          business: prep.business,
          operation: helper.toolName,
        })
        await dispatchEscalationHook({
          payload,
          argFlag: c.options.onEscalation,
          inMcp: inMcpMode,
          resolveHook: resolveHookImpl,
          runHook: runHookImpl,
        })
      }
      const cta = buildCta({
        toolName: helper.toolName,
        result,
        request: merged,
        isEscalation,
        advertisedExtensions: allowlistedExtensions(discovered),
      })
      // Apply --view AFTER CTA build: CTAs gate on the unprojected result
      // (variant.seller.url, line_items, etc.), so projecting first would
      // suppress action surfaces the agent needs. The projection replaces
      // the ENTIRE envelope with whatever the view emits; CTAs flow through
      // the incur extras channel so they survive any envelope reshape (see
      // view.ts for the contract rationale).
      return c.ok(
        applyView(
          { ...dispatchIdentity(prep.business, discovered, helper), ...hoistUcp(result) },
          viewState,
        ),
        ...(cta !== undefined ? [{ cta }] : []),
      )
    }

  // Args shapes for op commands. With business moved to a flag, only the
  // positional id varies: ops that target a specific resource carry one,
  // create/search/lookup don't.
  //
  // `id` is declared optional in the zod schema so `--input-schema` works
  // without a real id (`ucp checkout update --input-schema` should print the
  // schema, not error on a missing positional). Dispatch paths still require
  // it: prepareOperation / opRun gate on `c.args.id` and surface
  // MISSING_REQUIRED_ARG when the op is actually being dispatched.
  const argsEmpty = z.object({})
  const argsId = z.object({
    id: z
      .string()
      .optional()
      .describe(
        'Resource id (e.g. cart_id, checkout_id, order_id). Required for dispatch; omit only with --input-schema.',
      ),
  })

  const catalog = Cli.create('catalog', {
    description: 'Search for products, enumerate variants and options, check availability',
  })
    .command('search', {
      description:
        'Search a business catalog over UCP. --business is optional when the profile sets meta.defaults.catalog (global catalog fallback).',
      args: argsEmpty,
      options: operationOptions,
      run: opRun(searchCatalogImpl, undefined, 'catalog'),
    })
    .command('lookup', {
      description:
        'Batch lookup products or variants by identifier. --business is optional when the profile sets meta.defaults.catalog (global catalog fallback).',
      args: argsEmpty,
      options: operationOptions,
      run: opRun(lookupCatalogImpl, undefined, 'catalog'),
    })
    .command('get_product', {
      // The product/variant id is positional. Other catalog fields (selected,
      // preferences, filters, context, signals, attribution) are CLI-facing
      // body fields; the dispatcher wraps them under /catalog for the wire.
      description:
        'Fetch full detail for a single product (or variant). --business is optional when the profile sets meta.defaults.catalog (global catalog fallback).',
      args: argsId,
      options: operationOptions,
      run: opRun(getProductImpl, 'catalog', 'catalog'),
    })

  cli.command(catalog)

  // Cart envelope: `id` is top-level for get/update/cancel. CLI-facing body
  // fields are unwrapped (`--set /line_items=...`); the dispatcher nests them
  // under /cart on the wire. `create` has no positional id (server allocates
  // one). `get/cancel` take only an id.
  const cart = Cli.create('cart', {
    description: 'Build a shoppable cart with line items and cost estimates',
  })
    .command('create', {
      // Body fields are CLI-facing; the dispatcher wraps them under /cart for
      // the wire. Common case: --set '/line_items=[...]'.
      // Server allocates the cart id and returns it in the response.
      description: 'Create a new cart (seed line_items via --set /line_items=[...])',
      args: argsEmpty,
      options: operationOptions,
      run: opRun(createCartImpl, undefined, 'cart'),
    })
    .command('get', {
      description: 'Fetch a cart by id',
      args: argsId,
      options: operationOptions,
      run: opRun(getCartImpl, 'top'),
    })
    .command('update', {
      description: 'Update an existing cart',
      args: argsId,
      options: operationOptions,
      run: opRun(updateCartImpl, 'top', 'cart'),
    })
    .command('cancel', {
      description: 'Cancel a cart',
      args: argsId,
      options: operationOptions,
      run: opRun(cancelCartImpl, 'top'),
    })

  cli.command(cart)

  // Checkout envelope mirrors cart: `id` top-level, body under /checkout.
  // complete + cancel additionally require meta.idempotency-key per spec —
  // the dispatcher auto-injects when not supplied.
  const checkout = Cli.create('checkout', {
    description: 'Complete a purchase, pick fulfillment options, confirm payment',
  })
    .command('create', {
      // Body fields are CLI-facing; the dispatcher wraps them under /checkout
      // for the wire. Cart conversion is schema-shaped too: when advertised,
      // pass cart_id in --input alongside today's required line_items field.
      description: 'Create a checkout from line_items, or convert a cart with cart_id in --input',
      args: argsEmpty,
      options: operationOptions,
      run: opRun(createCheckoutImpl, undefined, 'checkout'),
    })
    .command('get', {
      description: 'Fetch a checkout by id',
      args: argsId,
      options: operationOptions,
      run: opRun(getCheckoutImpl, 'top'),
    })
    .command('update', {
      description: 'Update an existing checkout',
      args: argsId,
      options: operationOptions,
      run: opRun(updateCheckoutImpl, 'top', 'checkout'),
    })
    .command('complete', {
      description: 'Complete a checkout and place the order',
      args: argsId,
      options: operationOptions,
      run: opRun(completeCheckoutImpl, 'top'),
    })
    .command('cancel', {
      description: 'Cancel a checkout',
      args: argsId,
      options: operationOptions,
      run: opRun(cancelCheckoutImpl, 'top'),
    })

  cli.command(checkout)

  // Order is a single read-only op today (get_order). Mounted as a top-level
  // `ucp order get` so the surface is symmetric with cart/checkout `get` —
  // even though there is no `ucp order create` (orders are placed via
  // checkout complete). When list_orders / cancel_order land in the spec,
  // they'll slot in alongside get without restructuring.
  const order = Cli.create('order', {
    description: 'Check the status of an order after purchase',
  }).command('get', {
    description: 'Fetch an order by id',
    args: argsId,
    options: operationOptions,
    run: opRun(getOrderImpl, 'top'),
  })

  cli.command(order)

  // `profile *` is hidden from MCP clients per command in cli/profile.ts.
  cli.command(buildProfileCli(deps.profile ?? {}))

  cli.command('use', {
    description: 'Pin a business for the session (subsequent commands skip --business)',
    mcp: false,
    args: z.object({
      business: z
        .string()
        .optional()
        .describe('Business URL to bind as the session default (writes to ~/.ucp/active.yaml).'),
    }),
    options: z.object({
      clear: z
        .boolean()
        .default(false)
        .describe('Clear the session-default business instead of setting one.'),
    }),
    async run(c) {
      return runUse(
        omitUndefined({ business: c.args.business, clear: c.options.clear }),
        deps.use ?? {},
      )
    },
  })

  // `doctor` exits 1 when the verdict is `ok: false`, and prints the same
  // structured envelope either way. A `fail` severity that cannot fail a
  // build is decoration — and `protocol` is the first check whose failure
  // PREDICTS total failure (the business GETs the same profile URL and
  // hard-fails `-32001 profile_unreachable` if it cannot read it, or
  // negotiates a different release than the one we speak), so a green exit
  // there would be telling CI the install is healthy while every command is
  // guaranteed to fail. `--skip-network` is the offline/flake escape.
  //
  // Done by setting `process.exitCode` rather than `c.error(...)`: incur's
  // error sentinel REPLACES `data` with `{code, message}`, which would delete
  // the per-check array that is the entire point of the command. incur only
  // calls its exit handler on error paths, so a success return leaves this
  // value untouched and the process exits with it.
  cli.command('doctor', {
    description: 'Verify your install is healthy and businesses are reachable',
    mcp: false,
    args: z.object({}),
    options: z.object({
      skipNetwork: z
        .boolean()
        .default(false)
        .describe(
          'Skip network probes (fetching the hosted agent profile). Also the escape hatch for exit-code gating in offline or flaky-network CI.',
        ),
    }),
    async run(c) {
      const result = await runDoctor({
        ...(deps.doctor ?? {}),
        skipNetwork: c.options.skipNetwork,
      })
      if (!result.ok) process.exitCode = 1
      return result
    },
  })

  return cli
}

interface OperationOptions {
  input?: string | undefined
  set: string[]
  setString: string[]
  business?: string | undefined
  profile?: string | undefined
  profileUrl?: string | undefined
  refresh: boolean
  inputSchema: boolean
  dryRun: boolean
  onEscalation?: string | undefined
  header: string[]
  view?: string | undefined
}

// Minimum subset of incur's run context that op commands consume. `error` and
// `ok` are incur sentinels — returning them sets the result via side-effect
// and returns `never`. `ok` carries an optional `cta` block forwarded onto the
// success envelope; agents read `cta.commands` to know what to do next.
interface OperationContext {
  args: Record<string, unknown>
  options: OperationOptions
  error: (opts: ErrorEnvelopeOpts) => unknown
  ok: (data: unknown, meta?: { cta?: CtaBlock }) => unknown
}

// Run-time context for shopping commands. `id` is optional because
// create/search/lookup commands omit it; opRun handles undefined gracefully
// via mergeId. `business` lives in options, not args.
interface ShoppingRunContext extends OperationContext {
  // `id?: string | undefined` (not `id?: string`) so the type lines up with
  // incur's inferred context shape under exactOptionalPropertyTypes when the
  // zod schema makes the field optional.
  args: { id?: string | undefined }
  options: OperationOptions
}

// All shopping helpers share this signature (see services/shopping.ts).
// `capability`, `toolName`, and `opName` are own properties attached by
// `serviceOp` so `--input-schema` and package-local `--view :alias` can introspect
// the helper without maintaining parallel registries.
type ShoppingHelper = {
  (
    businessUrl: string,
    input: Record<string, unknown>,
    options: {
      force: boolean
      profileUrl: string
      /** Local profile name, for messages (see DiscoverOptions.profileName). */
      profileName?: string
      dryRun?: boolean
      /** Resolved outbound HTTP headers; see {@link resolveHeaders}. */
      headers?: Record<string, string>
      /** Internal-only side-channel; see CallOperationCallerOptions._onDiscover. */
      _onDiscover?: (discovered: DiscoveredBusiness) => void
    },
  ): Promise<unknown>
  capability: string
  toolName: string
  opName: string
}

type OperationBodyKey = 'catalog' | 'cart' | 'checkout'

// Adapter that ensures every helper at the dispatch boundary carries the
// metadata --input-schema and --view aliases need. Tests inject plain async
// stubs (no metadata), so we copy capability/toolName/opName from the production
// helper that the stub is replacing. Production callsite is a no-op (the
// imported helper already has the props). Mutating the override is safe — these
// stubs are local literals with no other consumers.
function withMeta(override: ShoppingHelperDep | undefined, prod: ShoppingHelper): ShoppingHelper {
  if (override === undefined) return prod
  return Object.assign(override, {
    capability: prod.capability,
    toolName: prod.toolName,
    opName: prod.opName,
  })
}

// Hoist a positional id into the operation input under the placement the
// spec dictates for that op family. `top` mirrors cart/checkout/order
// (id is a sibling of the body); `catalog` nests under /catalog because
// get_product's wire shape is { meta, catalog: { id, ... } }.
function mergeId(
  input: Record<string, unknown>,
  id: string | undefined,
  placement: 'top' | 'catalog' | undefined,
): Record<string, unknown> {
  if (id === undefined || placement === undefined) return input
  if (placement === 'top') return { ...input, id }
  const existing =
    typeof input.catalog === 'object' && input.catalog !== null && !Array.isArray(input.catalog)
      ? (input.catalog as Record<string, unknown>)
      : {}
  return { ...input, catalog: { ...existing, id } }
}

function wrapOperationInput(
  input: Record<string, unknown>,
  bodyKey: OperationBodyKey | undefined,
): Record<string, unknown> {
  if (bodyKey === undefined) return input
  if (Object.hasOwn(input, 'meta')) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: 'operation input cannot set meta (protocol-owned by the dispatcher)',
    })
  }
  return { [bodyKey]: input }
}

type PreparedOperation =
  | {
      ok: true
      input: Record<string, unknown>
      business: string
      profileName: string
      profileUrl: string
      force: boolean
    }
  | { ok: false; error: ErrorEnvelopeOpts }

// Prepares the cross-cutting bits every operation command needs: resolve the
// active session (with `--business` taking precedence over UCP_BUSINESS and
// active.yaml), require a resolved business URL, parse --input/--set/--set-string
// into a single JSON payload, hand back the profileUrl + force flag. Returns
// a discriminated result instead of throwing on missing-business so callers
// can `return c.error(prep.error)` and get incur's sentinel-path handling
// (which carries `cta` to the wire envelope).
async function prepareOperation(
  c: OperationContext,
  resolveSessionImpl: typeof resolveSession,
  bodyKey: OperationBodyKey | undefined,
  inMcpMode: boolean,
): Promise<PreparedOperation> {
  const session = await resolveSessionImpl(
    omitUndefined({
      business: c.options.business,
      profile: c.options.profile,
      profileUrl: c.options.profileUrl,
    }),
  )
  let business = session.business
  let usedCatalogDefault = false
  if (business === undefined) {
    // Catalog fallback rung — read-only by design. Catalog ops route through
    // `meta.defaults.catalog` when no business is resolved; cart/checkout
    // still error because routing a state-mutating op against the catalog
    // endpoint would silently misroute state-changing operations.
    if (bodyKey === 'catalog') {
      const catalogDefault = session.profile.meta?.defaults?.catalog
      if (catalogDefault !== undefined) {
        business = catalogDefault
        usedCatalogDefault = true
      }
    }
    if (business === undefined) {
      return { ok: false, error: businessNotResolvedError(inMcpMode) }
    }
  }
  vlog(
    `session: business=${business} (source: ${usedCatalogDefault ? 'meta.defaults.catalog' : (session.businessSource ?? '?')}) profile=${session.profile.name}`,
  )
  const input = await buildOperationInput({
    set: c.options.set,
    setString: c.options.setString,
    ...omitUndefined({ json: c.options.input }),
  })
  return {
    ok: true,
    input,
    business,
    profileName: session.profile.name,
    profileUrl: requireProfileUrl(session.profile.profileUrl),
    force: c.options.refresh,
  }
}

// `?? businessUrl` is defensive only: every caller has already routed the URL
// through session resolution / parseHttpsUrl, so canonicalizeOrigin should not
// fail here. Failing closed (throwing) would break dispatch on a non-bug; the
// raw string is a safe last-resort origin key against headers.json.
async function resolveCallHeaders(
  options: { header: string[] },
  session: { profile: { name: string } },
  businessUrl: string,
): Promise<HeaderMap> {
  return resolveHeaders({
    argFlags: options.header,
    origin: canonicalizeOrigin(businessUrl) ?? businessUrl,
    profile: session.profile.name,
  })
}

// Implements `--input-schema`: short-circuit before dispatch and return the
// upstream tool's `inputSchema` so agents can compose payloads without a
// trial-and-error round through schema validation. Discovery is lazy — if
// the local cache is cold this fetches once (TTL 60s). `--refresh` forces
// a re-fetch, mirroring the dispatch path.
//
// Design notes:
//   • Goes through `discoverImpl` (not `tools/list` directly) so transport
//     negotiation, capability lookup, and cache plumbing all stay shared
//     with the dispatch path. Single source of truth for "what does this
//     business expose?".
//   • `--input`/`--set` are ignored on purpose. `--input-schema` exists *to*
//     learn the input shape; rejecting them when present would punish
//     agents who ran `ucp <op> --set ... --input-schema` while exploring.
//   • Output is a flat envelope (business/capability/version/transport/
//     endpoint + tool). Agents grep `tool.inputSchema`; humans read the
//     surrounding context to confirm the right tool was discovered.
//   • Missing-business and missing-tool failures reuse the same wire
//     codes (BUSINESS_NOT_RESOLVED, OPERATION_NOT_OFFERED) as dispatch.
async function inputSchemaOperation(
  c: ShoppingRunContext,
  helper: ShoppingHelper,
  resolveSessionImpl: typeof resolveSession,
  discoverImpl: typeof discover,
  idPlacement: 'top' | 'catalog' | undefined,
  bodyKey: OperationBodyKey | undefined,
  inMcpMode: boolean,
): Promise<unknown> {
  const session = await resolveSessionImpl(
    omitUndefined({
      business: c.options.business,
      profile: c.options.profile,
      profileUrl: c.options.profileUrl,
    }),
  )
  let businessUrl = session.business
  if (businessUrl === undefined) {
    // Catalog fallback rung — agents that introspect first via `--input-schema`
    // must not hit a recovery dead-end. Mirrors prepareOperation: catalog
    // ops route through `meta.defaults.catalog`; everything else still
    // errors to avoid silently selecting a business for mutations.
    if (bodyKey === 'catalog') {
      const catalogDefault = session.profile.meta?.defaults?.catalog
      if (catalogDefault !== undefined) businessUrl = catalogDefault
    }
    if (businessUrl === undefined) return c.error(businessNotResolvedError(inMcpMode))
  }

  const profileUrl = requireProfileUrl(session.profile.profileUrl)
  const headers = await resolveCallHeaders(c.options, session, businessUrl)
  const resolved = await discoverImpl(businessUrl, {
    capabilities: [helper.capability],
    profileUrl,
    profileName: session.profile.name,
    force: c.options.refresh,
    headers,
  })
  const negotiated = resolved.negotiated[helper.capability]
  const tool = negotiated?.tools[helper.toolName]
  if (negotiated === undefined || tool === undefined) {
    throw new UcpError({
      layer: 'transport',
      code: ErrorCodes.OPERATION_NOT_OFFERED,
      message: `business does not expose "${helper.toolName}"`,
      context: {
        business: resolved.business,
        capability: helper.capability,
        offered: negotiated === undefined ? [] : Object.keys(negotiated.tools).sort(),
      },
    })
  }
  return c.ok({
    business: resolved.business,
    endpoint: negotiated.endpoint,
    transport: negotiated.transport,
    result: {
      capability: helper.capability,
      version: negotiated.version,
      client_policy: {
        unknown_plain_keys: 'rejected',
        extension_key_format: 'reverse-dns',
        description:
          'Operation inputs may use listed fields from tool.inputSchema. Unlisted business extension keys must be reverse-DNS names such as com.example.field.',
      },
      tool: {
        ...tool,
        inputSchema: projectCliInputSchema(tool.inputSchema, bodyKey, idPlacement),
      },
    },
  })
}

function projectCliInputSchema(
  schema: unknown,
  bodyKey: OperationBodyKey | undefined,
  idPlacement: 'top' | 'catalog' | undefined,
): unknown {
  const empty = { type: 'object', properties: {} }
  if (bodyKey === undefined) return empty
  if (!isPlainRecord(schema)) return empty
  const properties = isPlainRecord(schema.properties) ? schema.properties : undefined
  const bodySchema = properties?.[bodyKey]
  if (!isPlainRecord(bodySchema)) return empty

  const projected = structuredClone(bodySchema) as Record<string, unknown>
  if (idPlacement === 'catalog' && isPlainRecord(projected.properties)) {
    const { id: _id, ...nextProps } = projected.properties
    projected.properties = nextProps
    if (Array.isArray(projected.required)) {
      const required = projected.required.filter((field) => field !== 'id')
      if (required.length > 0) return { ...projected, required }
      const { required: _required, ...withoutRequired } = projected
      return withoutRequired
    }
  }
  return projected
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// `PROTOCOL_VERSION_INCOMPATIBLE.context` readers. Defensive rather than
// cast: `context` is typed `unknown` on UcpError, and a malformed context
// must degrade to "no hint", never take down the error path it decorates.
function offeredVersions(context: unknown): readonly string[] {
  if (!isPlainRecord(context)) return []
  const offered = context.offered
  return Array.isArray(offered) ? offered.filter((v): v is string => typeof v === 'string') : []
}

function activeProfileName(context: unknown): string | undefined {
  if (!isPlainRecord(context)) return undefined
  return typeof context.profileName === 'string' ? context.profileName : undefined
}

function requireProfileUrl(profileUrl: string | undefined): string {
  if (profileUrl !== undefined) return profileUrl
  throw new UcpError({
    layer: 'client',
    code: ErrorCodes.INVALID_INPUT,
    message:
      'active profile does not have a profile URL; pass --profile-url or set one on the profile',
  })
}

// CLI wire envelope for errors. Root fields are CLI-owned; business data never
// leaks to root. See opRun for the success payload shape — incur stamps `ok:
// true/false` at the outer envelope; UCP-side errors are distinguished by
// `code`. No redundant `status` field at the inner payload.
interface ErrorEnvelopeOpts {
  code: string
  message: string
  cta?: CtaBlock
  retryable?: boolean
}

// Which advertised extension ids the CTA layer may surface: the intersection
// of the ACTIVE AGENT PROFILE's declared capabilities with the business's.
// `discovered.expectedCapabilities` is exactly that intersection, computed in
// `discover()` from the identity that profile resolves to.
//
// Threat model: THE BUSINESS CANNOT EXPAND THE SET. Under `active ∩ business`,
// a merchant publishing `com.evil.exfiltrate` contributes nothing unless the
// user's local profile already declares it. The user controls that declaration,
// so a negotiated third-party capability such as `com.acme.loyalty` is allowed
// to reach the CTA layer.
//
// This is a PRESENTATION gate, not a security boundary for payloads. Payload
// pre-flight is `isAllowedUnknownExtensionKey` (a shape check against the
// negotiated release's `reverseDomainPattern`), and the authoritative field
// gate is the business's `inputSchema` — already shaped by server-side
// negotiation against this same profile.
//
// Returns an empty array when `discovered` is undefined (e.g. discover never
// completed, or the helper short-circuited before invoking `_onDiscover`),
// so CTA builders that read this field never have to null-check.
function allowlistedExtensions(discovered: DiscoveredBusiness | undefined): readonly string[] {
  return discovered?.expectedCapabilities ?? []
}

// Hoist the protocol `ucp` field out of the raw server response so it sits at
// the top of the CLI envelope alongside dispatch identity and `result` —
// rather than buried inside the payload. Keeps `result` as pure business
// payload while preserving full access to dynamic fields (capabilities,
// payment_handlers).
//
// Wire response shape:  { ucp: {...}, id: "...", line_items: [...] }
// Payload slot shape:   { ucp: {...}, result: { id: "...", line_items: [...] } }
function hoistUcp(result: unknown): Record<string, unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    return { result }
  }
  const { ucp, ...rest } = result as Record<string, unknown>
  return ucp !== undefined ? { ucp, result: rest } : { result: rest }
}

// Build the dispatch-identity prefix (`business`/`endpoint`/`transport`) that
// every UCP op response stamps at the envelope level. Reads endpoint/transport
// from the trusted negotiated view captured by the `_onDiscover` side-channel
// during helper execution — so the values reflect what actually went on the
// wire (post-cache, post-negotiation), not the user-facing input.
//
// Invariant: `discovered` is set by the time any helper returns successfully
// (the side-channel fires inside `callOperation` before any throw). If it's
// missing we surface stub values rather than crash — the dispatch happened
// (we have a result) and lying with empty strings is worse than missing data.
//
// `business` is normalized to the canonical `https://<host>` origin form for
// echo consistency: agents pass `--business shop.example.com` (bare)
// or `--business https://shop.example.com` (full), and either input
// must produce the same value in the response envelope. Prefer the canonical
// origin from `discovered` (already normalized inside discover); fall back to
// canonicalizing the raw input via parseHttpsUrl. Best-effort — if the input
// is somehow not even URL-shaped at this point, return as-is rather than
// throwing from a response-builder.
function dispatchIdentity(
  business: string,
  discovered: DiscoveredBusiness | undefined,
  helper: ShoppingHelper,
): { business: string; endpoint: string; transport: Transport } {
  const negotiated = discovered?.negotiated[helper.capability]
  return {
    business: canonicalizeBusinessForEcho(business, discovered),
    endpoint: negotiated?.endpoint ?? '',
    transport: negotiated?.transport ?? 'mcp',
  }
}

function canonicalizeBusinessForEcho(
  raw: string,
  discovered: DiscoveredBusiness | undefined,
): string {
  if (discovered?.business !== undefined && discovered.business !== '') {
    return discovered.business
  }
  if (acceptsHttpsUrl(raw)) {
    return parseHttpsUrl(raw, 'business URL').origin
  }
  return raw
}

// Build the BUSINESS_NOT_RESOLVED error envelope. Used at the run-handler
// boundary via `return c.error(businessNotResolvedError(inMcpMode))`. Two design
// notes worth preserving:
//
//  1. `c.error()` returns incur's error sentinel (NOT a thrown exception),
//     so the only way this reaches the wire envelope cleanly is by being
//     returned. Going through `c.error()` (instead of `throw new UcpError`)
//     is what makes `cta` survive — incur's default thrown-error catch
//     path emits only `code` + `message`. Agents read `error.cta.commands`
//     to recover.
//
//  2. The CTA block is constructed inside the function (not hoisted to
//     module scope) on purpose. Top-level await in the bin entrypoint
//     below suspends ESM evaluation; a module-scope `const` declared
//     after the entry can still be in TDZ when run handlers fire, while a
//     `var`-bound one can silently be `undefined`. Building the value at call
//     time eliminates the ordering hazard.
// Fires for non-catalog ops with no resolved business, or catalog ops on a
// profile without `meta.defaults.catalog`. MCP calls cannot use process-global
// active.yaml state, so their recovery only names invocation-scoped inputs.
function businessNotResolvedError(inMcpMode: boolean): ErrorEnvelopeOpts {
  if (inMcpMode) {
    return {
      code: ErrorCodes.BUSINESS_NOT_RESOLVED,
      message: 'no target business resolved',
      cta: {
        description:
          "Pass business in this tool call, or set UCP_BUSINESS in the MCP server host configuration. Resolution order: business → UCP_BUSINESS → (catalog tools) selected profile's meta.defaults.catalog.",
        commands: [
          {
            // Incur renders CTA commands in CLI syntax in both transports;
            // name the equivalent MCP argument explicitly in the description.
            command: 'ucp <op> --business <url> ...',
            description: 'retry this MCP tool with arguments.business set to the target URL',
          },
        ],
      },
    }
  }
  return {
    code: ErrorCodes.BUSINESS_NOT_RESOLVED,
    message: 'no target business resolved',
    cta: {
      description:
        "Bind a session-default business or pass one per call. Resolution order: --business → UCP_BUSINESS → ~/.ucp/active.yaml → (catalog ops) active profile's meta.defaults.catalog.",
      commands: [
        { command: 'ucp use <url>', description: 'bind a session-default business' },
        { command: 'ucp <op> --business <url> ...', description: 'or pass per call' },
      ],
    },
  }
}

// Resolve the escalation hook (per the three-source resolution order documented
// in src/core/escalation.ts) and fire it. Always async-await before returning
// the checkout envelope: the hook is *notification*, not gating, but sending
// the Slack/browser notification before the agent sees the result keeps the
// human-in-the-loop UX coherent. Hook failures are logged to stderr by
// runEscalationHook and don't change the operation outcome.
//
// MCP server mode skips the hook entirely (`inMcp: true`). An MCP server must
// not surprise the host process by spawning subprocesses or opening browsers;
// the structured envelope alone reaches the agent.
async function dispatchEscalationHook(opts: {
  payload: EscalationPayload
  argFlag?: string | undefined
  inMcp: boolean
  resolveHook: typeof resolveEscalationHook
  runHook: typeof runEscalationHook
}): Promise<void> {
  // Escalation is already represented in the structured checkout result and
  // CTA. Avoid unsolicited stderr on successful commands; direct CLI verbose
  // mode keeps a grep-able breadcrumb for humans debugging hook/handoff
  // behavior. MCP skips this escalation-specific trace, matching its no-hook
  // side-effect policy.
  if (!opts.inMcp) vlog(formatEscalationTrace(opts.payload))
  if (opts.inMcp) {
    await opts.runHook({ hook: undefined, payload: opts.payload, skip: true })
    return
  }
  const hook: EscalationHook | undefined = await opts.resolveHook({
    ...(opts.argFlag !== undefined && { argFlag: opts.argFlag }),
  })
  await opts.runHook({ hook, payload: opts.payload })
}

function formatEscalationTrace(payload: EscalationPayload): string {
  const reason = payload.reason ?? payload.status
  const url = payload.url ? ` → ${payload.url}` : ''
  const op = payload.operation ? ` [${payload.operation}]` : ''
  return `escalation${op}: ${reason}${url}`
}

// Match incur's own alias resolution for the `skills` builtin. incur registers
// `skills` with alias `skill`, so `ucp skill add` reaches the same builtin via
// `findBuiltin()` (incur/internal/command.js). If we only matched the plural
// here, the singular form would bypass this interceptor and ship the un-pruned
// auto-generated sub-skills via incur's built-in handler. Exported for tests.
export function isSkillsAddInvocation(argv: readonly string[]): boolean {
  return (
    (argv[0] === 'skills' || argv[0] === 'skill') &&
    argv[1] === 'add' &&
    !argv.includes('--help') &&
    !argv.includes('-h')
  )
}

export async function runUcpCli(
  argv = process.argv.slice(2),
  // Injectable so the version surface is unit-testable without spawning the
  // compiled binary (the compiled path is covered in the smoke integration).
  write: (s: string) => void = (s) => {
    process.stdout.write(s)
  },
): Promise<void> {
  // Intercepted here rather than handed to incur as `version` (see
  // Cli.create above). Runs before proxy/verbose setup: `--version` must not
  // depend on outbound networking being configurable.
  if (isRootVersionInvocation(argv)) {
    write(`${versionLine()}\n`)
    return
  }
  // `--mcp` toggles MCP stdio mode in incur. Detecting it at the executable
  // boundary and threading one `inMcpMode` value keeps MCP session isolation
  // and no-subprocess policy consistent while leaving run handlers importable
  // and side-effect free for tests/library consumers.
  const inMcpMode = argv.includes('--mcp')
  // `--verbose` flips on stderr trace output (see src/core/verbose.ts). Muted
  // in MCP mode — stderr during stdio JSON-RPC has no human reader and would
  // confuse log scrapers attached to the host.
  //
  // It cannot be handed to incur as a declared option. incur does expose a
  // custom-globals hook (`Cli.create({ globals, globalAlias })`), but
  // `verbose` sits on its reserved built-in name list, so declaring it throws
  // at construction: "Global option 'verbose' conflicts with a built-in flag."
  // The name is reserved and unimplemented — incur never parses `--verbose`
  // and never prints it in help — so `ucp --help` has no slot for it, and
  // README (Development → Debug tracing) is its canonical documentation.
  //
  // Registering it under some other name would still not serve this call
  // site:
  //   1. incur fills in global values only after command resolution, and
  //      middleware runs inside command execution — both within
  //      `cli.serve(...)`, i.e. after the proxy trace below has already run.
  //   2. `--mcp` returns from incur's run path before any global value is
  //      produced, and the MCP server never reads globals (tool calls arrive
  //      as JSON-RPC, not CLI args), so the server-lifetime verbose decision
  //      has to be made at process boot.
  //   3. `UCP_VERBOSE=1` enables the same trace for host configs that can't
  //      pass flags — and that detection naturally lives next to the flag.
  //
  // Strip it from the argv handed to incur: an undeclared flag reaches the
  // per-command schema, which rejects it with "Unknown flag: --verbose".
  const verboseRequested =
    argv.includes('--verbose') ||
    process.env.UCP_VERBOSE === '1' ||
    process.env.UCP_VERBOSE === 'true'
  if (!inMcpMode && verboseRequested) {
    setVerboseWriter((msg) => {
      process.stderr.write(msg)
    })
  }
  // The proxy decision is made in bin.ts before the verbose writer exists,
  // so it is traced here instead. It leads the trace because "are we proxying
  // at all" is the first question when debugging a corporate-network stall.
  vlog(`proxy: ${describeProxyState()}`)
  const serveArgv = argv.filter((a) => a !== '--verbose')
  // Intercept `ucp skills add` so we can prune incur's auto-generated
  // per-command sub-skills after the sync. Help, list, and bare `skills`
  // fall through to incur unchanged. MCP mode never runs `skills add`
  // (it's a stdio JSON-RPC server) so we don't bother gating on it.
  const isSkillsAdd = !inMcpMode && isSkillsAddInvocation(serveArgv)
  if (isSkillsAdd) {
    await syncSkillsWithCleanup({
      name: 'ucp',
      cli: createUcpCli({ inMcpMode }),
      description: CLI_DESCRIPTION,
      suggestions: SKILLS_SUGGESTIONS,
      argv: serveArgv.slice(2),
    })
  } else {
    await createUcpCli({ inMcpMode }).serve(serveArgv)
  }
}
