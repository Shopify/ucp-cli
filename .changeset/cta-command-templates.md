---
"@shopify/ucp-cli": patch
---

CTA commands are now templates on every operation: `<placeholders>` the agent fills from the response or its own previous request, composing the command for whatever shell it runs in. A template carries the shape of the next call without committing it to one shell's quoting rules, so the same CTA serves POSIX shells, PowerShell, and cmd.exe alike.

The catalog next-page CTA follows this contract — `ucp catalog search --input '<previous search body>' --set-string /pagination/cursor=<cursor>` — with its description naming `result.pagination.cursor` and the fields to carry forward (query, filters, context, limit). The skill and reference text say the same: copy the cursor verbatim into your previous search body; never construct, edit, or reuse one.
