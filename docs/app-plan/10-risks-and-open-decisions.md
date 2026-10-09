# 10 — Risks, Assumptions, and Open Decisions

> Status: **Draft for approval** · Update this document at every stage boundary (S0-10, S1-12, S3-10, …).

## 1. Decisions requiring human approval

Decisions marked **Blocking** must be resolved before the listed backlog item starts. Each has a recommendation; approving the plan as-is means accepting the recommendations unless noted.

| ID | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| **D-01** | How Recall gets local AI | (a) Require separately installed Ollama; (b) bundle Ollama's standalone build (MIT licence permits redistribution with notice; Windows offers a standalone zip for embedding/`ollama serve`); (c) in-process embeddings via ONNX (`@huggingface/transformers` + `onnxruntime-node`; nomic v1.5 ships ONNX weights) so semantic search works without Ollama | **(a) for MVP**, keyword-only fallback when absent. Revisit (c) after MVP as an "AI built in" option for search (vectors from ONNX and GGUF must not be mixed — separate embedding space). (b) adds ~hundreds of MB and update responsibility. | — (affects onboarding copy S2-04) |
| **D-02** | Reference development machine | The brief describes Windows 11 / Core Ultra 5 125U / 30 GB RAM. The machine inspected for this plan is **Windows 10 Pro 19045 / Ryzen 7 5700G (iGPU) / 15.4 GB RAM**. | Confirm which machine Stage 0 benchmarks run on. If both are available, benchmark on both (the 15.4 GB machine is closer to a typical user). | **Blocking** S0-04/05 (benchmarks) |
| **D-03** | Permission to download models during Stage 0 | Pull `nomic-embed-text` (274 MB per the Ollama library); optionally `qwen3-embedding:0.6b` (639 MB) and `embeddinggemma-2` for comparison | Approve `nomic-embed-text` + `qwen3-embedding:0.6b`. (This planning session did **not** pull anything.) | **Blocking** S0-04, S0-06 |
| **D-04** | Model licence policy and Stage 6 chat model | `qwen2.5:3b` (already on the dev machine) is under the **Qwen Research License** (not Apache-2.0); `gemma3`/`embeddinggemma` use Gemma Terms of Use; Apache-2.0/MIT alternatives: `qwen3:4b-instruct`, `granite4:micro`, `phi4-mini` | Policy: shipped defaults must be Apache-2.0/MIT (or legal-approved). Keep `qwen2.5:3b` for experiments only. Bake-off in S6-01 among the three alternatives. | **Blocking** S6-01 |
| **D-05** | Visual direction | As described in [02 §2](02-ux-and-user-flows.md) | Approve; refine with a clickable prototype review at end of S2-03 | S2-03 |
| **D-06** | OCR in scope for Stage 4 | (a) Opt-in `tesseract.js` with bundled English data; (b) defer to later | (a), opt-in, English only first; installer size impact (~tens of MB — measured) acceptable? | S4-06 |
| **D-07** | Code signing | Unsigned (SmartScreen warning); Azure Trusted Signing (cheapest; country-restricted eligibility); EV certificate (hardware token) | Unsigned for internal/hackathon builds; Azure Trusted Signing for any public release if eligible | S3-10 (public release only) |
| **D-08** | Encryption of the index at rest | (a) Rely on Windows account + recommend BitLocker; (b) SQLCipher-class encrypted SQLite (packaging complexity; key management via DPAPI) | (a) for MVP with honest copy; revisit if target users demand it | — |
| **D-09** | Evaluation corpus | Synthetic committed corpus (always); plus a private real-world corpus run locally with aggregate-only reporting | Approve both; nominate a team member to curate ~30 real queries with consent | S0-08, S1-11 |
| **D-10** | Remote repository and CI | GitHub (private) + Actions on `windows-latest`; or local only | GitHub private repo + CI as in [09 §10](09-team-and-workflow.md) | — |
| **D-11** | Uninstaller data behaviour | Keep data by default / ask / delete by default | Ask (unchecked "Also delete Recall's index") | S2-12 |
| **D-12** | Updates | None (manual reinstall); opt-in update checks later via `electron-updater` | None in MVP; opt-in later (it is a network call and must be disclosed) | post-MVP |
| **D-13** | Hackathon deadline and stage order | Deadline date unknown; Stage 5 vs 6 order | Provide the deadline. If before MVP completion, use the demo cut ([08 §11](08-development-roadmap.md)) and consider Stage 6 before Stage 5 | Planning of S2+ |
| **D-14** | Minimum supported OS | Windows 10 22H2 + Windows 11; or Windows 11 only | Support both for MVP (dev machine is Windows 10; Ollama requires Windows 10 22H2+). Note Windows 10 is past mainstream support; revisit for public release. | — |
| **D-15** | Content languages | English-only evaluation; multilingual best-effort | English for MVP evaluation; multilingual users served by model choice later (e.g. nomic v2-moe / qwen3-embedding are multilingual) | — |

## 2. Project-state facts that affect the plan (verified 2026-10-09)

| Fact | Evidence |
|---|---|
| Repository was **empty** (no code, docs, dependencies, or experiments); not a git repository | Directory listing returned zero entries; `git` reported no repository |
| No proof of concept exists in this repository; nothing has been tested | Same |
| Node 24.21.0, npm 11.19.0, git 2.53 installed; Python not installed | Version commands |
| Ollama 0.40.2 installed and server responding on `127.0.0.1:11434` | `ollama --version`, `GET /api/version` |
| Models present: **`qwen2.5:3b` only**; `nomic-embed-text` **not** present | `ollama list` |
| Machine: Windows 10 Pro 19045, AMD Ryzen 7 5700G with Radeon Graphics, 15.4 GB RAM | WMI queries |
| Side effect during inspection: running `pnpm --version` caused Corepack to download pnpm 12.10.1 into its global cache (no project or runtime change) | Command output |

## 3. Top risks

Likelihood/Impact: H/M/L.

| # | Risk | L | I | Mitigation | Early signal / owner |
|---|---|---|---|---|---|
| **R-01** | **CPU embedding throughput** makes initial indexing of a realistic corpus take hours on machines without a usable GPU | M–H | H | Measure in S0-04/06; two-phase indexing (keyword-searchable first); recently-modified-first ordering; batch-size tuning; smaller/faster model if needed; Matryoshka/dims options; clear progress UI | S0 throughput numbers |
| **R-02** | **Retrieval quality** on vague, paraphrased memories falls short of the promise | M | H | Hybrid RRF + file-name list; contextual headers; model bake-off; eval harness with per-type metrics; private real-world queries; temporal/version handling in S4 | S1-11 baseline |
| **R-03** | **Native module stack in Electron** (better-sqlite3 v13 N-API, sqlite-vec pre-1.0 DLL from asar, @parcel/watcher) fails in utilityProcess or packaged builds | M | H | S0-03 four-context spike; packaging from S2; fallbacks: `@electron/rebuild`, `node:sqlite`, `@photostructure/sqlite-vec`, JS brute-force vectors, chokidar | S0-03 |
| **R-04** | **Windows filesystem edge cases** — OneDrive placeholders triggering downloads, locked Office files, watcher gaps after sleep/overflow, network drives | H | M | Reconcile is authoritative; attribute-based placeholder skip (S0-07); backoff for locks; overflow → rescan; network drives best-effort | S0-07 |
| **R-05** | **Ollama as an external dependency** — install friction, auto-updates changing behaviour, user-selected cloud models, server not running | M | M–H | Readiness state machine; keyword-only fallback; version + digest logging; vetted local-model list + cloud rejection; D-01 option (c) post-MVP | Usability test; S0-04 |
| R-06 | sqlite-vec maintenance/breaking changes (pre-1.0) | M | M | Pinned version; `VectorIndex` interface; JS brute-force fallback is simple at MVP scale | Upstream releases |
| R-07 | PDF text reconstruction quality (columns, tables, headers/footers) | M | M | Fixture-driven heuristics; show extracted text honestly; detail view lets users verify | S0-09 |
| R-08 | Memory pressure (Electron + Ollama embed + chat model on 8–16 GB) | M | M | Measure; `keep_alive` control; chat optional and gated by free-memory check | S3-08, S6 |
| R-09 | Small-model hallucination / weak citations in Ask | H | M | Retrieval-first; JSON schema; citation & quote validation; abstention; labels | S6-04 |
| R-10 | Prompt injection via documents | M | M | No tools for LLM; deterministic actions; delimiting; eval suite | S6-04 |
| R-11 | Eval overfits the synthetic corpus | M | M | Held-out split; private real corpus; usability session | S1-11, S3-10 |
| R-12 | Single implementer scope creep | M | M | Milestone loop; stage gates; demo cut | Each report |
| R-13 | Model licences unsuitable for distribution | M | M | D-04 policy; vetted list | S0/S6 |
| R-14 | Unsigned installer / SmartScreen friction for testers | H | L–M | D-07; tester instructions | S2-12 |
| R-15 | Windows 10 end of mainstream support | M | L | D-14; test on Windows 11 too | — |
| R-16 | Electron upgrade cadence (8 weeks; 3 supported majors) causes churn | M | L | Upgrade one major at stage boundaries; pin exact | Release schedule |

## 4. Assumptions register

Product assumptions are in [01 §9](01-product-specification.md). Technical assumptions:

| ID | Assumption | Status | Validated by |
|---|---|---|---|
| TA-01 | better-sqlite3 v13's N-API prebuild loads unchanged in Node 24 and current Electron, including `utilityProcess` | Unverified (release notes say "should theoretically work") | S0-03 |
| TA-02 | sqlite-vec loads from `app.asar.unpacked` in packaged builds | Unverified (known upstream issue #194; fork exists) | S0-03 |
| TA-03 | Exact vector search is fast enough at ≤ 200k chunks | **Verified 2026-10-09** for latency (p95 110 ms at 200k, in-memory JS); memory exceeds NFR-09 above ~100k chunks → S4-09 int8 | S0-05 ✓ |
| TA-04 | `nomic-embed-text` effective context under Ollama ≥ 2,048 tokens | Unverified (library page says 2K; params mention 8192) | S0-04 |
| TA-05 | Ollama stops generation when the client aborts the HTTP request | Unverified (not in API docs) | S6-01 |
| TA-06 | `stat().ino` (bigint) is stable across rename/move on NTFS | Partially verified (Node issue discussion); safe-save editors may change it | S0-07 |
| TA-07 | pdf.js legacy build runs in a worker thread inside `utilityProcess` | Unverified | S0-09 |
| TA-08 | Cloud models can be reliably distinguished via Ollama's API | Unverified | S0-04 |
| TA-09 | `@parcel/watcher` reports enough information on Windows to coalesce moves | Unverified | S0-07 |

## 5. Evidence status of key claims in this plan

| Category | Examples |
|---|---|
| **Verified facts** (with sources in the docs) | Electron 44 current with Node 24.21; Electron security checklist items and fuse defaults; `utilityProcess` purpose and MessagePorts; better-sqlite3 13 is N-API with FTS5 enabled; sqlite-vec 0.1.9 is pre-1.0 and brute-force, vec0 features; Ollama `/api/embed` batch + `truncate` default + normalisation; Ollama default context 4,096 below 24 GiB VRAM; nomic-embed-text 768 dims, prefixes, Apache-2.0; Qwen2.5-3B Research License; tesseract.js fetches language data from a CDN by default; Node `fs.Stats` lacks Windows attributes; Electron `openPath` NUL-byte advisory |
| **Engineering recommendations** | Architecture, schema, RRF baseline, chunk parameters, two-phase indexing, confidence rule structure, security controls, roadmap |
| **Assumptions** | §4 and [01 §9](01-product-specification.md) |
| **Unverified hypotheses** | All performance targets in [01 §5](01-product-specification.md); whether hybrid beats single modes on Recall's corpus; storage estimate in [05 §8.1](05-data-model-and-indexing.md); whether a 3–4B local model gives acceptable grounded answers on CPU |
| **Not done in this session** | No code written, no dependencies installed, no models pulled, no tests or benchmarks run |
