import { runUcpCli } from './cli.js'

// Keep the package executable as a tiny unconditional entrypoint. The CLI
// factory lives in cli.ts for tests/imports; this module is only reached through
// package.json#bin, so it must not use an import.meta/process.argv[1] guard.
await runUcpCli()
