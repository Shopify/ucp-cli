// `ucp use <business>` / `ucp use --clear` — set or clear the session-default
// business URL.
//
// Persists `business` in `~/.ucp/active.yaml`. Reset is `--clear` (not a bare
// `--`, which incur consumes as the flag terminator before the run handler
// sees it). Validation is HTTPS-only because PROTOCOL mandates HTTPS for
// business endpoints — storing a malformed URL here would surface as a
// confusing transport error later.
//
// Pure function so cli.ts wires the incur command and tests can call this
// directly with mock readActive/writeActive.

import { type ActiveSession, readActive, writeActive } from '../core/profile-store.js'
import { parseHttpsUrl } from '../core/url.js'
import { ErrorCodes, UcpError } from '../lib/errors.js'

export interface UseDeps {
  readActive?: typeof readActive
  writeActive?: typeof writeActive
  homeDir?: string
}

export interface UseResult {
  business: string | null
  previous: string | null
}

export interface UseInput {
  business?: string | undefined
  clear?: boolean
}

export async function runUse(input: UseInput, deps: UseDeps = {}): Promise<UseResult> {
  const readAct = deps.readActive ?? readActive
  const writeAct = deps.writeActive ?? writeActive
  const storeOpts = deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}

  if (input.clear === true) {
    if (input.business !== undefined) {
      throw new UcpError({
        layer: 'client',
        code: ErrorCodes.INVALID_INPUT,
        message: 'pass either <business> or --clear, not both',
      })
    }
    const prev = await readAct(storeOpts)
    if (prev.business === undefined) return { business: null, previous: null }
    const { business: _omit, ...cleared } = prev
    await writeAct(cleared as ActiveSession, storeOpts)
    return { business: null, previous: prev.business }
  }

  if (input.business === undefined) {
    throw new UcpError({
      layer: 'client',
      code: ErrorCodes.INVALID_INPUT,
      message: 'usage: ucp use <business> | ucp use --clear',
    })
  }

  const url = parseHttpsUrl(input.business, 'business URL').origin
  const prev = await readAct(storeOpts)
  await writeAct({ ...prev, business: url }, storeOpts)
  return { business: url, previous: prev.business ?? null }
}
