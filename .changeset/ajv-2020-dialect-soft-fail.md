---
"@shopify/ucp-cli": patch
---

Fix `MCP_INVALID_RESPONSE` errors on every dispatch against businesses that
publish JSON Schema draft 2020-12 inputSchemas, and make client-side
pre-flight validation best-effort instead of fail-closed.

The pre-flight input validator previously used AJV's draft-07-only build and
threw on the 2020-12 meta-schema URI (`https://json-schema.org/draft/2020-12/schema`)
before inspecting any payload. Every `catalog search`, `cart create`,
`checkout *`, and `order *` call against MCP servers that advertise the
2020-12 dialect returned:

```
MCP_INVALID_RESPONSE: business returned an invalid input schema for "<tool>"
Details: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

Three changes:

1. **2020-12 dialect support.** The validator now uses AJV's 2020-12 build
   (`Ajv2020`), which registers the 2020-12 meta-schema. Schemas declaring
   2020-12 — or no `$schema` at all — compile and validate normally.

2. **Soft signals replace hard throws for client-side uncertainty.** When
   the published schema cannot be compiled (unknown dialect, malformed JSON
   Schema) or when an argument carries a plain key not listed in the
   published schema, the dispatcher no longer fails the call. The server is
   the authoritative validator and returns `SCHEMA_VALIDATION_FAILED` for
   genuinely bad payloads. Three modes:

   - **default** — silent; the request proceeds and the server decides.
   - **`--verbose` / `UCP_VERBOSE=1`** — emit a `vlog()` trace so operators
     can see what was flagged and why.
   - **`UCP_STRICT_SCHEMA=1`** — restore the throw (`MCP_INVALID_RESPONSE`
     for compile failures, `SCHEMA_VALIDATION_FAILED` for unknown plain
     keys). Useful in CI or for paranoid local development.

   Payload validation against a successfully compiled schema still throws
   `SCHEMA_VALIDATION_FAILED` in every mode — local typo-catching saves a
   server round-trip.

3. **Removed `patchKnownUpstreamSchemaDefects` (the `\A` regex stopgap).**
   The upstream defect it worked around is fixed in production, and the
   new soft-fail path handles any future regex-incompatibility regression
   without a hard failure.

Upgrade impact:

- Agents and scripts that previously branched on `MCP_INVALID_RESPONSE` from
  the pre-flight path will no longer see it in the default mode. Set
  `UCP_STRICT_SCHEMA=1` to restore the old strict behavior.
- The previous client-side rejection of "unknown plain fields" no longer
  fires by default. Reverse-DNS extension keys remain the recommended
  convention; the CLI just doesn't enforce it client-side anymore.
- No new error codes.
