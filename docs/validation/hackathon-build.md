# Hackathon build: what was built and what was verified

> Date: 2026-10-09 · Machine: Windows 10 Pro 19045, AMD Ryzen 7 5700G (iGPU), 15.4 GB RAM · Ollama 0.40.2 · Electron 44.7.0 (Node 24.21.0)
>
> Decision D-13: the hackathon deadline is **2026-10-10**. This build is a one-day cut of the plan, not the MVP defined in [01 §7](../app-plan/01-product-specification.md). Decisions taken: D-02 = this PC is the benchmark machine; D-03 = `nomic-embed-text` only (pulled); D-09 = synthetic corpus only.

## Scope delivered

| Area | Delivered | Differs from plan |
|---|---|---|
| Processes | Engine in `utilityProcess`; sandboxed renderer; typed preload API; main validates sender + params | Manual validation instead of zod |
| Storage | SQLite (better-sqlite3 13), content-addressed schema, FTS5 (porter) for chunks + file names | Vectors searched **in memory in JS** (exact cosine), not via sqlite-vec — ADR-006 fallback option; fine at demo scale |
| Formats | TXT, Markdown, code/config files, PDF (pdf.js 6 legacy), DOCX (mammoth) | Extraction in the engine's event loop with a timeout, not in worker threads |
| Indexing | Two-phase (keyword first, then meaning), reconcile scan with generations, `fs.watch` recursive + debounce, periodic reconcile, hash dedupe, rename without re-embedding, GC, pause/resume, retry | No placeholder (OneDrive) detection; `@parcel/watcher` not used |
| Search | RRF over keyword-any, keyword-all, meaning, and file-name lists; meaning-only results trimmed by a cosine margin; snippets with highlights; match reasons; duplicate collapse; low-confidence flag | Filters, temporal ranking and version grouping not built |
| Ask | Grounded answers from top passages with `qwen2.5:3b`, streamed, numbered citations validated, abstention marker, "Inferred:" labelling | No JSON-schema output or quote verification (plan §9) |
| UI | Onboarding, search + evidence, document detail, Ask, Folders, Settings (AI status, data size, delete all data), status bar | No global shortcut, no search history |
| Security | contextIsolation, sandbox, CSP, navigation/window/permission denial, renderer network blocked, loopback-only `fetch` guard in engine, open-file guard (IDs, realpath, root check, executable denylist), blocked system/AppData folders | No fuses set; no firewall-log audit performed |
| Packaging | electron-builder NSIS per-user installer, unsigned (138 MB) | — |

## Verification evidence (all run on 2026-10-09)

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass |
| Unit + integration (no model, network guard on) | `npm test` | **25 / 25 passed** |
| Retrieval eval, live model | `npm run test:live` → `eval-results/latest.md` | see below |
| Ask, live model | `npm run test:live` (ask.test.ts) | 2 / 2 passed: cited answer for the Acme payment question (17.7 s); abstained on "When does my passport expire?" (6.5 s) |
| App smoke (dev build) | `electron . --smoke-test=tests/fixtures/corpus` | exit 0; 18 files, 29 chunks, all 3 queries correct top file, 32–37 ms; no renderer errors |
| App smoke (dev server) | `npm run dev -- --smoke-test=…` | ok (renderer loads under CSP with HMR) |
| App smoke (**packaged** `Recall.exe`) | `dist/win-unpacked/Recall.exe --smoke-test=…` | exit 0; same results |
| Visual check | `--smoke-screenshots` | 7 screens captured and reviewed |

### Retrieval eval (synthetic corpus, 18 files, 20 answerable + 5 negative queries, nomic-embed-text)

| Mode | Hit@5 | Recall@5 | MRR@10 |
|---|---|---|---|
| keyword only | 0.95 | 0.95 | 0.89 |
| meaning only | 0.95 | 0.94 | 0.90 |
| hybrid, plain RRF (baseline) | 1.00 | 1.00 | 0.85 |
| **hybrid as shipped** (+ all-terms list, meaning margin 0.10) | **1.00** | **1.00** | **0.95** |

- Average results per query: 15.0 (baseline) → 8.4 (shipped).
- Low-confidence cosine threshold: flags 3/5 negative queries and 0/20 answerable ones at any τ from 0.58 to 0.66; **0.62** was chosen. That is below the plan's 0.70 target for negatives.
- Cosine ranges overlap: top-1 for answerable queries is 0.542–0.775, for negative ones 0.476–0.600. Meaning similarity alone cannot separate them.
- Warm hybrid query including query embedding: p50 37 ms.
- **Caveat:** 25 queries on 18 synthetic files are too few to generalise. The numbers show the pipeline works and that the changes helped on this set, nothing more.

### Throughput (this machine)

- `nomic-embed-text` via `/api/embed`: cold single query 608 ms; warm single query 36 ms; batches of 8/16/32 chunks (~230 tokens each) in 1.2 / 2.3 / 4.5 s, i.e. ~7 chunks/s.
- Fixture corpus fully indexed (extract + embed) in 4.5–6 s.
- `/api/show` reports `nomic-bert.context_length = 2048` (resolves assumption TA-04). An oversized input with `truncate:false` returns "the input length exceeds the context length".

## Not verified / known gaps

- The offline procedure ([07 §8](../app-plan/07-testing-and-acceptance.md)) has **not** been run, so Recall is "designed for offline use", not verified offline.
- No OS-level network audit. Only the in-process `fetch` guard (engine, tests) and renderer request blocking are in place.
- **Not exercised by automation:** the native folder picker, the "Start Ollama" button, the model download flow, and stopping Ollama mid-session. The code paths exist; check them by hand before the demo.
- Large real-world folders have not been tried. Expect roughly 7 chunks/s for the meaning phase on this CPU.
- `qwen2.5:3b` is research-licensed: fine for the demo, not as a shipped default (D-04).
