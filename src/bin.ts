import { runUcpCli } from './cli.js'
import { installProxyDispatcher } from './core/proxy.js'

// Keep the package executable as a tiny unconditional entrypoint. The CLI
// factory lives in cli.ts for tests/imports; this module is only reached through
// package.json#bin, so it must not use an import.meta/process.argv[1] guard.

// The proxy dispatcher must be installed from this entrypoint only (see
// core/proxy.ts for why Node needs it at all): in cli.ts it would mutate the
// process-global dispatcher for every test that imports runUcpCli; in
// index.ts it would break the "sideEffects": false contract for library
// consumers. Awaited so no request can start on the direct dispatcher; free
// when no proxy is configured (undici is not even imported).
await installProxyDispatcher()
await runUcpCli()
