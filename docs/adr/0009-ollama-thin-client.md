# ADR-0009: Ollama through a thin loopback-only HTTP client

**Status:** Accepted (2026-10-09)

**Decision.**
- Our own client in `src/engine/ollama.ts`, built on `fetch` and `AbortController`.
- Endpoints used:
  - `/api/version` and `/api/tags`
  - `/api/embed`, with `truncate: false`
  - `/api/pull`, streamed
  - `/api/chat`, streamed, with an explicit `num_ctx`
- Hosts other than loopback are rejected, as are model names ending in `-cloud`.
- Ollama is not bundled with Recall (D-01).

**Alternatives.**
- The official `ollama` npm client.
- node-llama-cpp in-process (Electron allows it only in the main process).

**Evidence.** Verified against the live Ollama server:
- batch embedding works and returns unit vectors;
- oversized input fails loudly instead of being truncated;
- `/api/show` reports a context length of 2048;
- Ask streams answers with qwen2.5:3b.

**Open.** The pull flow and "Start Ollama" haven't been exercised automatically, and there are no tests against a fake server yet (S1-07).
