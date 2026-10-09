# ADR-0013: Loopback-only network policy

**Status:** Accepted (2026-10-09) for normal use, validated by an automated audit. The manual offline procedure is still pending.

**Decision.** Recall's own processes connect only to Ollama on 127.0.0.1. Model downloads are done by Ollama itself, and only after explicit consent in the UI.

**Enforced.**
- **Renderer.** The CSP allows network access only to the app itself. `webRequest` cancels every request other than local files and the dev server. Navigation, new windows and permissions are denied.
- **Main and engine.** `src/engine/network-guard.ts` patches Node below `fetch`, http(s), net, tls, dns and dgram. Any non-loopback attempt fails with `ERR_RECALL_NETWORK_BLOCKED`.
- **Chromium.** Started with `--no-proxy-server`, so proxy auto-detection (WPAD) never queries the local network.
- **Ollama client.** Checks the host and rejects cloud models. A test-only `RECALL_OLLAMA_URL` must still be loopback.
- **Tests.** A setup-file guard fails any test that tries a non-loopback call.

**Evidence** ([network-audit-2026-10-09.md](../validation/network-audit-2026-10-09.md)):
- `npm run audit:network` drives the full app flow with the real Ollama and records Recall's guard log, Chromium's net log, and Windows' TCP table for the process tree.
- Built and packaged app: zero connections or lookups other than loopback.
- The first audit run found WPAD DNS queries, which are now disabled.

**Not yet done.**
- The manual offline procedure ([07 §8](../app-plan/07-testing-and-acceptance.md)).
- A Windows Firewall log audit (needs admin rights).

**Note.** The Ollama tray app checks for its own updates. That traffic comes from Ollama, outside Recall's processes.
