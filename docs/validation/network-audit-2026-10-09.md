# S3-07 (automated part): network audit

> Date: 2026-10-09 · Machine: Windows 10 Pro 19045, Wi-Fi/Ethernet connected, Windows proxy "Automatically detect settings" on · Ollama 0.40.2 with `nomic-embed-text` and `qwen2.5:3b` · Electron 44.7.0

## Question

Does Recall itself send anything off this computer while it is used normally? Recall's processes are main, the engine and the renderer. Ollama and its own update checks are out of scope (ADR-0013).

## Method

`npm run audit:network` (spec: `tests/audit/network.spec.ts`) drives the real app with the real Ollama through the flow in [07 §8](../app-plan/07-testing-and-acceptance.md):

> onboarding with models present → add the fixture folder → index → 20 searches (the first 20 eval queries) → details, Open, Show in folder → one Ask → remove the folder → delete all data

It records network activity in three independent ways:

| Layer | What it sees | How |
|---|---|---|
| 1. Recall's guard | Every Node connection attempt in main and the engine: `fetch`, http(s), net, tls, dns, dgram | `RECALL_NETWORK_AUDIT=<file>` makes the guard log each attempt |
| 2. Chromium net log | The renderer and Chromium's network service: URL requests, DNS, sockets, proxy detection | Electron's `--log-net-log=<file>` switch |
| 3. Windows TCP table | Every TCP connection owned by any process in Recall's process tree, whatever made it | `Get-NetTCPConnection`, polled about 5×/s (`tests/audit/watch-connections.ps1`) |

The run fails on any blocked attempt in layer 1, any non-loopback host or URL in layer 2, or any non-loopback address in layer 3.

## Results

| App | Layer 1 (guard) | Layer 2 (net log) | Layer 3 (TCP table) | Result |
|---|---|---|---|---|
| Built app (`out/`, development Electron) | 5 attempts, all engine → 127.0.0.1:11434, 0 blocked | 16 events, no URL requests, no hosts | 4 connections, all 127.0.0.1 | **pass** |
| Packaged app (`dist/win-unpacked/Recall.exe`) | same | same | same | **pass** |

In layer 3, the two connections to 127.0.0.1:11434 belong to the engine before and after "Delete all data", which restarts it. The other two are Playwright's control connection to the app. The guard counts reused connections once, which is why 20 searches, indexing and Ask show as 5 attempts.

## What the audit found (fixed)

The first run failed on layer 2. **Chromium's proxy auto-detection (WPAD)** was running:
- It asked DHCP for a proxy script.
- It then sent DNS queries for the name `wpad` to the local network, four times in one session.
- Each lookup triggered an IPv6 reachability probe (a UDP "connect" to Google's public DNS address, which sends no packets).

No user data was involved, but these queries did leave the machine, and they would also do so on any network Recall is used on. Recall loads only local files, so main now starts Chromium with `--no-proxy-server`. The re-run shows no DNS, proxy or socket events.

Also fixed while building the audit:
- The engine's old guard covered only `fetch`. The new guard (`src/engine/network-guard.ts`) runs in **both main and the engine**, below every Node networking API.
- Its unit tests found a bypass in the first draft: HTTP requests pass `path: null`, which the draft mistook for a named pipe. The tests now prove that blocked TCP, HTTP, DNS and UDP fail, that loopback works, and that `fetch` goes through the hook.

## Limits

- **Not the manual offline procedure.** That still needs a person: network adapters off, reboot, then the full checklist ([07 §8](../app-plan/07-testing-and-acceptance.md), steps 1–13). Until it passes, Recall is "verified not to connect out in normal use", not yet "verified to work offline".
- **No firewall-log audit.** Enabling Windows Firewall logging needs admin rights.
- **Layer 3 is polled.** A connection shorter than about 200 ms could be missed there, but it would still show in layer 1 or 2.
- **Layer 1 does not cover `dns.Resolver` instances.** The Node guard patches the module-level DNS functions only. Any resulting connection would still be blocked and logged at the socket level.
- **Ollama is out of scope.** Ollama's own traffic, such as update checks and model downloads after consent, is outside Recall's processes and not audited here.
- **One flow, one machine.** Other screens, such as "Get Ollama", open the user's browser by design.
