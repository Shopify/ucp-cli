---
'@shopify/ucp-cli': minor
---

Honor standard proxy environment variables. When `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY`/`http_proxy` is set, the CLI routes requests through the proxy (respecting `NO_PROXY`) instead of silently ignoring it and stalling until the request timeout. Adds a `proxy` check to `ucp doctor`, a `--verbose` trace line, and names the proxy in transport, HTTP, and invalid-body error messages so a proxy failure can't be misread as an unreachable merchant. Credentials are redacted everywhere. Implemented via undici's `EnvHttpProxyAgent`, loaded only when a proxy variable is set.
