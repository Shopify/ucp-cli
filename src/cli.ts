// CLI entrypoint.
//
// The top-level `Cli` is intentionally real even before project-specific
// commands are registered: incur provides built-ins such as --version,
// --help, --llms, --mcp, `mcp add`, and `skills`. Integration tests should
// exercise this dispatcher directly so output shape stays faithful.

import { fileURLToPath } from 'node:url'

import { Cli, middleware, z } from 'incur'

import { buildCta } from './cli/cta.js'
import { type DoctorDeps, runDoctor } from './cli/doctor.js'
import { buildOperationInput } from './cli/input.js'
import { buildProfileCli, type ProfileCliDependencies } from './cli/profile.js'
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
import { isDryRunPreview } from './core/operation.js'
import { DEFAULT_AGENT_CAPABILITY_IDS } from './core/profile.js'
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
    dryRun?: boolean
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
   * When true, the escalation hook is skipped. MCP servers must not surprise
   * the host process with subprocesses or browser launches. Set at the bin
   * entrypoint based on `process.argv.includes('--mcp')`. Test injection
   * lets specs exercise both branches without spawning real children.
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
  const discoverImpl = deps.discover ?? discover
  const resolveSessionImpl = deps.resolveSession ?? resolveSession
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

  const cli = Cli.create('ucp', {
    description: CLI_DESCRIPTION,
    format: 'json',
    version: __CLI_VERSION__,
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
      // fired had `meta.defaults.catalog` been set, so when it didn't, the init
      // CTA is the recovery path.
      if (businessUrl === undefined) return c.error(businessNotResolvedError())
      const discoverResult = await discoverImpl(businessUrl, {
        force: c.options.refresh,
        profileUrl: requireProfileUrl(session.profile.profileUrl),
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
  const inMcpMode = deps.inMcpMode === true
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
      const prep = await prepareOperation(c, resolveSessionImpl, bodyKey)
      if (!prep.ok) return c.error(prep.error)
      const wrapped = wrapOperationInput(prep.input, bodyKey)
      const merged = mergeId(wrapped, c.args.id, idPlacement)
      // Capture the trusted negotiated view via the internal side-channel.
      // Filled by `callOperation` after `discover()` resolves (BEFORE any
      // OPERATION_NOT_OFFERED throw), so CTAs on transport-layer failures
      // still have advertised-capability context. The intersection with our
      // bundled-profile capability set happens at the CTA boundary — keeps
      // the side-channel a pure pass-through of the typed discover result.
      let discovered: DiscoveredBusiness | undefined
      const result = await helper(prep.business, merged, {
        force: prep.force,
        profileUrl: prep.profileUrl,
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

  cli.command(buildProfileCli(deps.profile ?? {}))

  cli.command('use', {
    description: 'Pin a business for the session (subsequent commands skip --business)',
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

  cli.command('doctor', {
    description: 'Verify your install is healthy and businesses are reachable',
    args: z.object({}),
    options: z.object({
      skipNetwork: z
        .boolean()
        .default(false)
        .describe('Skip network probes (profile fetch, hosting URL reachability).'),
    }),
    async run(c) {
      return runDoctor({
        ...(deps.doctor ?? {}),
        skipNetwork: c.options.skipNetwork,
      })
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
// via mergeId. `business` no longer lives in args (moved to options).
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
      dryRun?: boolean
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
      return { ok: false, error: businessNotResolvedError() }
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
    profileUrl: requireProfileUrl(session.profile.profileUrl),
    force: c.options.refresh,
  }
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
    if (businessUrl === undefined) return c.error(businessNotResolvedError())
  }

  const profileUrl = requireProfileUrl(session.profile.profileUrl)
  const resolved = await discoverImpl(businessUrl, {
    capabilities: [helper.capability],
    profileUrl,
    force: c.options.refresh,
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

// Intersect business-advertised capability ids (the TRUSTED, schema-parsed
// view from `discover()`) with this CLI's bundled capability set
// (`DEFAULT_AGENT_CAPABILITY_IDS`). Returns the subset of advertised
// extensions the CTA layer is permitted to surface to agents.
//
// Why allowlist:
//   * The business profile is schema-validated but the capability KEYS are
//     free-form reverse-domain strings. A business can publish any name. Even
//     trusted (parsed-by-CLI) names should not propagate into agent-facing
//     guidance unless we know what they mean. The allowlist is the bridge.
//   * The allowlist is compile-time-frozen — `DEFAULT_AGENT_CAPABILITY_IDS` is
//     derived once from the bundled `localAgentProfileBody()` template at
//     module load. A runtime-mutable allowlist would be an escalation target;
//     the immutability is the security property.
//   * Single source of truth: anything this CLI is willing to *negotiate* is
//     the same thing it *advertises* in its agent profile. If we add a
//     capability to the bundled profile, the filter accepts it automatically;
//     if we drop one, the filter rejects it automatically. No separate list
//     to keep in sync.
//
// Returns an empty array when `discovered` is undefined (e.g. discover never
// completed, or the helper short-circuited before invoking `_onDiscover`),
// so CTA builders that read this field never have to null-check.
function allowlistedExtensions(discovered: DiscoveredBusiness | undefined): readonly string[] {
  if (discovered === undefined) return []
  const capabilities = discovered.profile.ucp.capabilities
  if (typeof capabilities !== 'object' || capabilities === null) return []
  const advertised = new Set(Object.keys(capabilities))
  return DEFAULT_AGENT_CAPABILITY_IDS.filter((ext) => advertised.has(ext))
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
// boundary via `return c.error(businessNotResolvedError())`. Two design
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
//     after the entry would still be in TDZ when run handlers fire, and
//     a `var`-bound one would silently be `undefined` — exactly how this
//     bug bit us before. Building the value at call time eliminates the
//     ordering hazard entirely.
// Fires for non-catalog ops with no resolved business, or catalog ops on a
// user profile without `meta.defaults.catalog`. Recovery is the same either
// way: bind a business via `ucp use` or `--business`. No `--catalog` re-init
// rung — heavier than just binding a business for the current call.
function businessNotResolvedError(): ErrorEnvelopeOpts {
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

// Resolve the escalation hook (per the four-source resolution order documented
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

// Binary entrypoint stays at the bottom of the module. See note (2) on
// businessNotResolvedError above for the ESM-ordering rationale.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // `--mcp` toggles MCP stdio mode in incur. The escalation hook must be a
  // no-op in that mode (see src/core/escalation.ts). Detecting at the entry
  // and threading via `inMcpMode` keeps the run-handler boundary clean.
  const inMcpMode = process.argv.includes('--mcp')
  // `--verbose` flips on stderr trace output (see src/core/verbose.ts). Muted
  // in MCP mode — stderr during stdio JSON-RPC has no human reader and would
  // confuse log scrapers attached to the host. Two reasons we detect from
  // argv at entry rather than registering with incur:
  //   1. `--mcp` mode bypasses incur's per-command argv parsing (tool calls
  //      arrive as JSON-RPC, not CLI args). The verbose decision for the
  //      server lifetime has to be made at process boot.
  //   2. `UCP_VERBOSE=1` enables the same trace for host configs that can't
  //      pass flags — and that detection naturally lives next to the flag.
  // Strip --verbose from the argv handed to incur because it's not a
  // registered incur option; unrecognized tokens get forwarded to the
  // per-command schema, which would reject them. The flag is also not
  // listed in `ucp --help` Global Options — incur 0.4.5 hard-codes that
  // block (Help.js:262) with no extension hook. Documented in README under
  // Development → Debug tracing until upstream exposes a registration API.
  const argv = process.argv.slice(2)
  const verboseRequested =
    argv.includes('--verbose') ||
    process.env.UCP_VERBOSE === '1' ||
    process.env.UCP_VERBOSE === 'true'
  if (!inMcpMode && verboseRequested) {
    setVerboseWriter((msg) => {
      process.stderr.write(msg)
    })
  }
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
