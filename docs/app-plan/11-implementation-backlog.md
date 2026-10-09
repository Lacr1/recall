# 11 — Implementation Backlog

> Status: **Draft for approval** · Process: [09 Workflow](09-team-and-workflow.md) · Stages: [08 Roadmap](08-development-roadmap.md)
>
> Ordered, dependency-aware items. Each is sized for one implementation session (S ≈ ½ day, M ≈ 1 day, L ≈ 1½–2 days; L items may be split at the implementer's discretion with a note). **Do not start an item until every dependency is merged** and listed decisions are resolved.
>
> "Verify" lines use the standard scripts in [09 §3.1](09-team-and-workflow.md). Base verification for every item: `npm run typecheck && npm run lint && npm test` (from S0-02 onward).

## How to read an item

- **Depends on** — items that must be merged; **Decisions** — entries in [10](10-risks-and-open-decisions.md) that must be resolved.
- **Scope** — files/modules expected to change. Touching other areas requires a note in the report.
- **Interfaces** — contracts created or consumed (names are descriptive; exact signatures are an implementation detail).
- **Tests** — tests to write in this item.
- **Acceptance** — must all be true; **Evidence** — what the report must include.
- **Watch** — likely regressions.

---

## Stage 0 — Discovery and technical validation

Spike code lives in `spikes/<id>/` (excluded from builds and lint), is kept for reference, and is never imported by `src/`.

### S0-01 — Repository initialisation and ADRs · S
- **Depends on:** plan approval. **Decisions:** D-10 (remote hosting) optional.
- **Scope:** `.gitignore`, `.editorconfig`, `README.md` (root, short), `docs/adr/0001…0013-*.md`, `docs/app-plan/README.md` changelog.
- **Tasks:** `git init`; commit the approved plan as-is; write ADR-001…013 from [03 §9](03-system-architecture.md) (status "Proposed — pending Stage 0 validation" where applicable).
- **Tests:** none.
- **Verify:** `git log --oneline` shows the initial commit; ADR files render.
- **Acceptance:** repo initialised on `main`; ADRs present; no source code yet.
- **Evidence:** commit hash; file list.

### S0-02 — Toolchain skeleton with pinned versions · M
- **Depends on:** S0-01.
- **Scope:** `package.json`, lockfile, `.nvmrc`, `tsconfig.*.json`, `electron.vite.config.ts`, ESLint/Prettier config, `vitest.config.ts`, `src/{main,preload,renderer,engine,shared}/` minimal entry files, one trivial test.
- **Tasks:** install the approved dependencies ([03 §3.3](03-system-architecture.md)) at **exact** versions (latest stable Electron at that date; Vite version compatible with electron-vite's peer range); record versions + licences in `docs/validation/dependencies.md`; ESLint `no-restricted-imports` rules for module boundaries ([03 §5.3](03-system-architecture.md)); ban `dangerouslySetInnerHTML`; window opens a blank React page with secure `webPreferences`.
- **Tests:** trivial unit test; lint rule self-test (a fixture file violating a boundary fails lint).
- **Verify:** base verification + `npm run dev` opens a window.
- **Acceptance:** all scripts in [09 §3.1](09-team-and-workflow.md) exist (those not yet meaningful exit 0 with "not implemented"); all licences acceptable or flagged.
- **Evidence:** versions table; screenshot or log of window launch.
- **Watch:** electron-vite ↔ Vite version mismatch.

### S0-03 — Native module and process-model spike · M
- **Depends on:** S0-02.
- **Scope:** `spikes/s0-03-native/`, `docs/validation/stage0-report.md` (section).
- **Tasks:** in four contexts — plain Node (Vitest), Electron main, Electron `utilityProcess`, packaged app (electron-builder, `asarUnpack`) — verify: better-sqlite3 v13 opens a DB; WAL; FTS5 table + `bm25()` query; sqlite-vec loads (`sqlite-vec` vs `@photostructure/sqlite-vec`), `vec_distance_cosine` works, `vec0` table works; resolve `app.asar.unpacked` path for the DLL. If v13 fails in Electron, try `@electron/rebuild`; if that fails, evaluate `node:sqlite` with `allowExtension`.
- **Tests:** spike assertions script.
- **Verify:** spike script exit 0 in each context; packaged exe log.
- **Acceptance:** one combination works in all four contexts and is recorded (ADR-004/006 confirmed or amended).
- **Evidence:** matrix of context × capability with pass/fail and versions.
- **Watch:** prebuild not shipped for the Electron version; asar path resolution.

### S0-04 — Ollama integration probe · S
- **Depends on:** S0-02. **Decisions:** D-02 (benchmark machine), D-03 (approval to pull `nomic-embed-text`).
- **Scope:** `spikes/s0-04-ollama/`, report section.
- **Tasks:** record `/api/version`, `/api/tags` (digests); pull `nomic-embed-text` via `/api/pull` streaming and capture the progress event sequence; `/api/show` → effective context length & `model_info`; `/api/embed` with batch input, `truncate:false` with an oversized input (expect error), verify normalisation and dims; measure cold vs warm single-query latency and batch throughput for sizes 8/16/32/64; find the Ollama desktop executable path for "Start Ollama"; determine how to detect cloud models from `/api/show`/`/api/tags`; observe behaviour when Ollama is quit mid-request.
- **Acceptance:** all above documented with raw numbers; batch size default chosen; cloud-model detection rule written.
- **Evidence:** JSON samples (no private text), timings table.
- **Watch:** Ollama auto-updating mid-stage — record version each run.

### S0-05 — Vector search benchmark · M
- **Depends on:** S0-03. **Decisions:** D-02 (benchmark machine).
- **Scope:** `spikes/s0-05-vectors/`, report section; ADR-006 status.
- **Tasks:** synthetic normalised 768-dim vectors at 10k / 50k / 200k / 500k rows; measure p50/p95 top-100 latency for (a) BLOB table + `vec_distance_cosine` ORDER BY LIMIT, (b) `vec0` KNN, (c) JS brute force over Float32Array/Int8 copy; with and without a selective SQL filter; measure DB size per 10k vectors; measure insert throughput in transactions of 16.
- **Acceptance:** recommendation for ADR-006 with numbers; scale ceiling stated.
- **Evidence:** benchmark table with machine spec.
- **Watch:** OS file cache effects — report cold and warm.

### S0-06 — Embedding model candidates (pilot) · S
- **Depends on:** S0-04, S0-08. **Decisions:** D-03 (pulling candidate models).
- **Scope:** `spikes/s0-06-models/`, report section.
- **Tasks:** embed the corpus v0 with `nomic-embed-text` and `qwen3-embedding:0.6b` (and `embeddinggemma-2` only if licence confirmed); run pilot queries with a minimal brute-force semantic search; record Recall@10/MRR (semantic-only) and chunks/s.
- **Acceptance:** default model confirmed or a switch proposed per the rule in [04 §5.1](04-search-and-retrieval.md); results labelled "pilot, 30 queries".
- **Evidence:** metrics table, throughput table.
- **Deferrable:** can be folded into S1-11 if time-boxed out.

### S0-07 — Windows filesystem spike · M
- **Depends on:** S0-02.
- **Scope:** `spikes/s0-07-fs/`, report section.
- **Tasks:** placeholder detection: compare `koffi` + `GetFileAttributesW`, `fswin`, batched PowerShell — correctness on a OneDrive online-only file (if an OneDrive account is available; else synthetic attribute via `attrib`/test file and document the gap) and cost per 10k files; `stat(..., {bigint:true}).ino` stability across rename/move/edit-with-save (Word, Notepad, VS Code "safe write"); long path read/open; `EBUSY` reproduction with a file opened by Word; `@parcel/watcher` event shapes for rename/move/bulk copy/delete-folder and overflow behaviour; `fs.opendir` walk speed on 50k files.
- **Acceptance:** mechanism chosen for placeholders; ino usage decided (hint or unused); watcher behaviour table.
- **Evidence:** tables + notes.
- **Watch:** OneDrive account availability (D-02 related).

### S0-08 — Evaluation corpus v0 and pilot queries · M
- **Depends on:** S0-01. **Decisions:** D-09 (corpus source).
- **Scope:** `tests/fixtures/corpus/` (v0, ~120 files), `scripts/make-fixtures.ts` (generates PDF/DOCX from Markdown sources — needs a PDF/DOCX writer dev-dependency; propose in report), `tests/eval/queries.jsonl` (≥ 30), `tests/fixtures/corpus/README.md` (provenance; synthetic only).
- **Tasks:** author persona-based documents ([07 §5.1](07-testing-and-acceptance.md)) including versioned proposals, meeting notes, a small code project, manuals, distractors, exact duplicates; write pilot queries across types incl. 5 negatives; grade relevance.
- **Acceptance:** corpus covers TXT/MD/PDF/DOCX/code; queries validated (every relevant path exists).
- **Evidence:** corpus stats (files per type), query type counts.

### S0-09 — Extraction spike · S
- **Depends on:** S0-02, S0-08.
- **Scope:** `spikes/s0-09-extract/`, report section.
- **Tasks:** pdfjs-dist legacy build inside a `worker_thread` in Node and in `utilityProcess`; per-page text + simple paragraph reconstruction quality on corpus PDFs; password-protected PDF → `PasswordException`; PDF without text layer → empty items; mammoth on DOCX (headings via HTML mode); timing per MB; memory peak.
- **Acceptance:** extractor approach confirmed; any pdf.js Node quirks documented (worker/font settings).
- **Evidence:** timings, sample outputs (synthetic docs only).

### S0-10 — Stage 0 report and target revision · S
- **Depends on:** S0-03 … S0-09.
- **Scope:** `docs/validation/stage0-report.md`, updates to [01 §5](01-product-specification.md) targets, ADR statuses, [10](10-risks-and-open-decisions.md), effort re-estimate in [08](08-development-roadmap.md).
- **Acceptance:** every Stage 0 acceptance item in [08 §3](08-development-roadmap.md) answered with evidence; revised NFR numbers; human sign-off.
- **Evidence:** the report.

---

## Stage 1 — Retrieval foundation (headless engine)

### S1-01 — Common foundations · M
- **Depends on:** S0-10.
- **Scope:** `src/engine/common/{logger,network-guard,clock,errors}.ts`, `src/shared/{errors,types,settings}.ts`, tests.
- **Interfaces:** `RecallError` + codes ([03 §7](03-system-architecture.md)); `Logger` with field allowlist + path hashing ([06 §7](06-security-and-privacy.md)); `installNetworkGuard(mode)`; `Clock`; settings registry with defaults/validation.
- **Tests:** guard blocks `fetch`/`http`/`net`/`dns` to non-loopback and allows `127.0.0.1`/`::1`/`localhost`; logger redaction (canary strings); settings validation.
- **Acceptance:** guard installed in Vitest global setup in `fail` mode for all future tests.
- **Watch:** guard must not break loopback fake servers.

### S1-02 — Database module, migrations, initial schema · L
- **Depends on:** S1-01, S0-03.
- **Scope:** `src/engine/db/**`, `tests/integration/db/**`.
- **Interfaces:** `openDatabase(path)` (pragmas per [05 §2](05-data-model-and-indexing.md), sqlite-vec load), migration runner (user_version, checksums, backup via `VACUUM INTO`, transactional apply, newer-version refusal), repositories for folders/files/contents/chunks/vectors/settings/embedding_spaces, FTS triggers, `assertIndexConsistent(db)`.
- **Tests:** fresh migrate; re-run no-op; failing migration rolls back + backup restore; newer-version refusal; cascades (folder → files; content → chunks → FTS → vectors) leave no orphans; partial-unique path keys; `quick_check` after each test.
- **Acceptance:** schema matches [05 §4](05-data-model-and-indexing.md) (or deltas documented); all tests pass.
- **Watch:** FTS external-content delete trigger correctness (must pass old values).

### S1-03 — Extraction framework and text/markdown/code extractors · M
- **Depends on:** S1-01, S0-09.
- **Scope:** `src/engine/extract/{worker,registry,pool}.ts`, `extractors/{text,markdown,code}.ts`, fixtures.
- **Interfaces:** `Extractor` contract ([04 §2.2](04-search-and-retrieval.md)); pool with concurrency, per-file timeout, `resourceLimits`, recycle-after-N, structured failure codes.
- **Tests:** encodings (UTF-8/BOM/UTF-16/1252), CRLF, binary detection, minified detection, Markdown heading paths, code block splitting hints, timeout fixture (worker terminated, pool recovers), oversized → `too_large`.
- **Acceptance:** extractors return normalised text with correct offsets (property test: every block's `[charStart,charEnd)` slice equals its text).

### S1-04 — PDF and DOCX extractors · M
- **Depends on:** S1-03.
- **Scope:** `extractors/{pdf,docx}.ts`, sniffing, fixtures (good, password, no-text, corrupt, wrong extension, zip-bomb-like DOCX).
- **Tests:** page numbers preserved; hyphenation join; password → `EXTRACT_PASSWORD`; no text → `EXTRACT_NO_TEXT` with `textlessPages`; DOCX headings/tables; decompressed-size cap.
- **Acceptance:** all fixtures produce expected status; no crash of the pool on any fixture.

### S1-05 — Chunker · M
- **Depends on:** S1-03.
- **Scope:** `src/engine/chunk/**`.
- **Interfaces:** `chunk(extracted, embeddingInfo, config)` → chunks with offsets/pages/section paths; `buildEmbeddingText(chunk, contentMeta)` (prefix + header, [04 §3.3](04-search-and-retrieval.md)); `chunker_version` constant.
- **Tests:** heading boundaries; sentence-preserving packing; overlap within section only; min-size merge; hard cap honoured for pathological input (one 50k-char line); stitching non-overlapping parts reproduces the full text exactly (property test); config variants for eval.
- **Acceptance:** parameters configurable for experiments; defaults per [04 §3.2](04-search-and-retrieval.md).

### S1-06 — Folders, scanner, reconcile, hashing · L
- **Depends on:** S1-02, S0-07.
- **Scope:** `src/engine/folders/**`, `src/engine/scan/{walker,reconcile,attributes,path-rules}.ts`, `src/engine/pipeline/hash.ts`.
- **Interfaces:** folder add (overlap rules, system-location rejection), remove (immediate purge), exclusions (defaults + user globs); `reconcileFolder(folderId)` per [05 §6.1](05-data-model-and-indexing.md); hashing lane function; `isInsideRoot`; placeholder check (mechanism from S0-07).
- **Tests:** change-detection matrix via reconcile ([07 §4.2](07-testing-and-acceptance.md)); missing root → `unavailable`, nothing deleted; junction escaping root not followed; path validation property tests (`..`, UNC, device, ADS, NUL); overlapping folder add/merge.
- **Acceptance:** matrix rows passing for reconcile; touch-without-change causes zero extraction.

### S1-07 — Ollama client, AI runtime, embedding providers · M
- **Depends on:** S1-01, S0-04.
- **Scope:** `src/engine/ai/**`, `tests/support/fake-ollama-server.ts`, `tests/support/{fake,recorded}-embedding-provider.ts`.
- **Interfaces:** `AiRuntime` (probe, listModels, pull w/ progress + abort, start — start stubbed until S2), `EmbeddingProvider` (Ollama, fake, recorded); loopback validation; vetted model list + cloud-model rejection; timeouts; circuit breaker state.
- **Tests:** against FakeOllamaServer: probe states; pull stream parsing incl. disconnect/resume; embed count/dims mismatch; `truncate:false` error → split signal; non-loopback host rejected before request; cloud model rejected; abort mid-request. `@live` tests for real Ollama (opt-in).
- **Acceptance:** `npm test` passes without Ollama; `npm run test:live` passes on dev machine.

### S1-08 — Pipeline scheduler · L
- **Depends on:** S1-04, S1-05, S1-06, S1-07.
- **Scope:** `src/engine/pipeline/{scheduler,extract-lane,embed-lane,gc}.ts`.
- **Interfaces:** lanes per [03 §6](03-system-architecture.md); `pause()/resume()`; progress snapshot; per-content atomic writes (chunks+FTS in one txn; vectors+status in one txn); GC per [05 §7](05-data-model-and-indexing.md); embedding space bootstrap (first `dims` check).
- **Tests:** full corpus indexing with fake provider; keyword-searchable before embeddings complete; AI down → embed lane waits without consuming attempts, resumes; batch bisection on poison chunk; pause/resume; **crash loop** (engine run as child process, killed at random points, 20 seeded iterations → `assertIndexConsistent`); duplicate content embedded once (provider call counts).
- **Acceptance:** crash loop 20/20; no unbounded memory growth on 2k-file corpus (RSS sampled).

### S1-09 — Search service · L
- **Depends on:** S1-08, S0-05.
- **Scope:** `src/engine/search/**`.
- **Interfaces:** `search({q, filters, limit, mode?}, signal)` → `SearchResponse` (files, copies, evidence chunks with highlight ranges and location, match reasons, mode, timings, confidence flag); FTS query builder (sanitised); file-name list; `VectorIndex` (default impl per ADR-006); RRF; grouping; duplicate collapse; snippet windows; query-embedding LRU.
- **Tests:** FTS syntax injection (`"`, `*`, `NEAR`, `-`, parentheses) never errors; RRF unit tests; aggregation; filters applied in every list; keyword-only mode when provider unavailable; cancellation; highlight ranges correct against stitched text; duplicate collapse picks newest copy as primary.
- **Acceptance:** end-to-end search on fixture corpus returns expected top file for 10 smoke queries.

### S1-10 — Headless engine host and CLI · S
- **Depends on:** S1-09.
- **Scope:** `src/engine/host.ts` (start engine without Electron), `scripts/recall-cli.ts` (`index <folder>`, `query "<text>"`, `status`).
- **Acceptance:** CLI indexes fixture corpus with live Ollama and prints results with evidence; used by eval/bench.

### S1-11 — Evaluation harness, query set, baseline · L
- **Depends on:** S1-10, S0-08.
- **Scope:** `scripts/eval.ts`, `tests/eval/queries.jsonl` (→ 80 queries), `tests/eval/recorded-embeddings/`, `eval-results/`.
- **Tasks:** metrics (Recall@k, MRR@10, nDCG@10, P@5) at file level; three modes; per-type tables; per-query diff between runs; recorded-embedding generation command (live) and replay (CI); experiment configs (chunk size, overlap, header on/off, RRF k, aggregation); held-out split; initial τ computation for low-confidence ([04 §6.5](04-search-and-retrieval.md)).
- **Tests:** metric functions unit-tested against hand-computed examples.
- **Acceptance:** baseline report committed; Stage 1 gates evaluated ([07 §5.4](07-testing-and-acceptance.md)); experiments run and adopted/rejected with rationale; τ stored or low-confidence UI marked disabled.
- **Evidence:** report tables; adopted-config ADR if defaults change.

### S1-12 — Stage 1 benchmarks and report · S
- **Depends on:** S1-11.
- **Scope:** `scripts/bench.ts`, `docs/validation/stage1-report.md`.
- **Acceptance:** benchmarks in [07 §6](07-testing-and-acceptance.md) run on dev machine; NFR status table; Stage 1 acceptance ([08 §4](08-development-roadmap.md)) evidenced; human sign-off.

---

## Stage 2 — Desktop MVP

### S2-01 — Engine host in utilityProcess and supervisor · M
- **Depends on:** S1-12.
- **Scope:** `src/engine/index.ts`, `src/engine/rpc/**`, `src/main/engine/supervisor.ts`.
- **Interfaces:** RPC framing `{id, method, params}` / `{id, result|error}` / `{event, data}`, cancellation messages; supervisor restart policy ([03 §7](03-system-architecture.md)); data dir in `%LOCALAPPDATA%\Recall` ([05 §2](05-data-model-and-indexing.md)); single-instance lock.
- **Tests:** RPC round-trip, error propagation as `RecallError`, cancellation, engine crash → restart → pending calls rejected with `ENGINE_RESTARTING`.
- **Acceptance:** app starts engine, survives killing it.

### S2-02 — Security baseline, preload API, IPC router · M
- **Depends on:** S2-01.
- **Scope:** `src/main/security/**`, `src/main/ipc/router.ts`, `src/preload/index.ts`, `src/shared/ipc/contract.ts`.
- **Tasks:** everything in [06 §5](06-security-and-privacy.md) except fuses; IPC contract per [03 §10](03-system-architecture.md); zod validation + `senderFrame` check; network guard in main; `webRequest` blocking; CSP.
- **Tests:** contract fuzz (fast-check) for every channel; sender check rejects subframe; E2E asserts no Node globals, CSP present, navigation/window.open denied.
- **Acceptance:** SEC-01, SEC-02 verified.

### S2-03 — App shell and design system · M
- **Depends on:** S2-02. **Decisions:** D-05 (visual direction).
- **Scope:** `src/renderer/app/**`, `src/renderer/components/**`, Tailwind tokens.
- **Tasks:** layout (rail, content, evidence pane, status bar, banners), light/dark from system, focus styles, keyboard map scaffolding, `F6` regions, live-region utility, `forced-colors` support.
- **Acceptance:** axe clean on shell; keyboard navigation between regions.

### S2-04 — Onboarding flow · L
- **Depends on:** S2-03, S1-07.
- **Scope:** `src/renderer/features/onboarding/**`, main dialog handler for `folders.add`, `ai.*` channels, `ai.startRuntime` implementation.
- **Tasks:** screens 5.1–5.3 ([02](02-ux-and-user-flows.md)); readiness state machine; consented pull with progress/cancel; folder add via main-owned dialog; sync-folder warning; overlap handling; "Skip" to keyword-only; first-run flag.
- **Tests:** E2E with FakeOllamaServer for: not installed, stopped, model missing → download, ready; skip path.
- **Acceptance:** E2E flows 1–2 reach the progress screen.

### S2-05 — Indexing progress and status events · S
- **Depends on:** S2-04.
- **Scope:** `features/onboarding/progress`, status bar, `indexing.*` channels, throttled events.
- **Acceptance:** two-phase bars; pause/resume; skipped count link; "Start searching" available immediately.

### S2-06 — Search screen, results, evidence pane · L
- **Depends on:** S2-03, S1-09.
- **Scope:** `src/renderer/features/search/**`.
- **Tasks:** debounce 250 ms, cancellation of superseded queries, results listbox (virtualised), highlights as `<mark>` text nodes, match reason chips, copies, mode/partial banners, empty/no-match/low-confidence/error states, keyboard map.
- **Tests:** component tests for highlight rendering (no HTML injection with a malicious file name/passage fixture); E2E search flow.
- **Acceptance:** NFR-05 met on fixture corpus in the app.

### S2-07 — Document detail view · M
- **Depends on:** S2-06.
- **Scope:** `features/document/**`, `documents.get` engine method (stitching, paged).
- **Acceptance:** large document virtualised; match navigation; "changed since indexed" detection (size/mtime differ) with re-index action.

### S2-08 — Open / reveal / copy with open-file guard · S
- **Depends on:** S2-06.
- **Scope:** `src/main/files/open-guard.ts`, channels.
- **Tests:** allowlist/denylist; NUL; outside root; deleted file → targeted reconcile request; executable types never reach `shell.openPath` (spy).
- **Acceptance:** SEC-03, SEC-04 verified.

### S2-09 — Folders management screen · M
- **Depends on:** S2-03, S2-05.
- **Scope:** `features/folders/**`, `folders.*`, `failures.list`, `indexing.retry`.
- **Acceptance:** remove confirmation copy as specified; data size decreases after removal (E2E flow 4); failure reasons in plain language; exclusions edit with validation.

### S2-10 — Settings and privacy & data · M
- **Depends on:** S2-03.
- **Scope:** `features/settings/**`, `data.*`, `settings.*`, `diagnostics.export`.
- **Acceptance:** data location/size shown; delete-all (type-to-confirm) wipes data dir and returns to onboarding (E2E flow 6); logs "include paths" toggle; About states network policy.

### S2-11 — E2E harness and accessibility checks · M
- **Depends on:** S2-04 … S2-10.
- **Scope:** `tests/e2e/**`, `src/main/testing/hooks.ts` (excluded from production), Playwright config, axe integration.
- **Acceptance:** E2E flows 1, 2, 4, 6, 7 pass; axe zero serious/critical.

### S2-12 — Packaging (NSIS), fuses, smoke test · M
- **Depends on:** S2-02 (can run in parallel with S2-03…S2-11).
- **Scope:** `electron-builder.yml`, fuses config, `--smoke-test` path in main, test-build variant for E2E.
- **Acceptance:** installer installs per-user; packaged smoke passes; production fuses verified (e.g. `npx @electron/fuses read`); E2E runs against the test build.
- **Evidence:** installer size, smoke output.

---

## Stage 3 — Reliability (→ MVP 1.0)

### S3-01 — Live watcher · M
- **Depends on:** S2-11.
- **Scope:** `src/engine/scan/watcher.ts`.
- **Acceptance:** change-detection matrix passes via watcher; bursts coalesced; watcher errors/overflow → reconcile.

### S3-02 — Reconcile triggers and unavailable folders · S
- **Depends on:** S3-01.
- **Scope:** power events (main → engine), periodic reconcile, availability polling, UI status.
- **Acceptance:** unplugged drive simulation → `unavailable`, results greyed, index kept; resume from sleep triggers reconcile.

### S3-03 — Placeholders, locked files, long paths · S
- **Depends on:** S3-01, S0-07.
- **Acceptance:** placeholder files skipped with reason (manual OneDrive check recorded); locked files retried with backoff; long paths indexed and opened.

### S3-04 — Recovery: integrity, rebuild, migration backup · M
- **Depends on:** S2-11.
- **Acceptance:** corrupted DB → rebuild flow; failed migration → backup restored; crash loop rerun in packaged app context; `quick_check` on startup within time budget.

### S3-05 — AI resilience · S
- **Depends on:** S2-11.
- **Acceptance:** Ollama stop/start during indexing and search → banners, keyword fallback, automatic recovery (E2E flow 3); model digest change → re-embed prompt.

### S3-06 — Crash and error UX · S
- **Depends on:** S3-04, S3-05.
- **Acceptance:** all rows of [02 §5.13](02-ux-and-user-flows.md) implemented and E2E-tested where automatable.

### S3-07 — Network audit and offline validation · M
- **Depends on:** S3-01 … S3-06.
- **Scope:** `scripts/audit-network.ts`, `docs/validation/{network-audit,offline}-*.md`, `docs/validation/offline-queries.md`.
- **Acceptance:** guard-mode audit zero violations; firewall-log audit zero drops; manual offline procedure ([07 §8](07-testing-and-acceptance.md)) all steps pass.

### S3-08 — Performance pass · M
- **Depends on:** S3-01 … S3-05.
- **Acceptance:** NFR-03/04/07/08/09 at revised targets on dev machine (bench report); regressions vs Stage 1 explained.

### S3-09 — Accessibility pass · S
- **Depends on:** S3-06.
- **Acceptance:** NVDA + Narrator checklist; 200% scaling; high contrast; report in `docs/validation/a11y-*.md`.

### S3-10 — User docs, clean-machine test, MVP release candidate · S
- **Depends on:** S3-07, S3-08, S3-09.
- **Scope:** `docs/user/` (install, Ollama setup, privacy, troubleshooting), release notes.
- **Acceptance:** clean-machine install → first search ≤ 15 min (models pre-pulled); all Stage 3 acceptance items evidenced; human MVP sign-off.

---

## Stage 4 — Search improvements

| ID | Title | Size | Depends on | Key acceptance |
|---|---|---|---|---|
| S4-01 | Filters (type, folder, date) UI + chips | M | MVP | Filters reflected in every candidate list; chips removable; keyboard accessible |
| S4-02 | Temporal intent parser + recency list | M | S4-03 (query set part) | Temporal queries ≥ 0.8 Recall@5 for intended version; non-temporal metrics unchanged (±0.01) |
| S4-03 | Query set → 160; ranking experiments round 2; τ calibration to targets | L | MVP | Stage 4 gates ([07 §5.4](07-testing-and-acceptance.md)) |
| S4-04 | Near-duplicate/version grouping (MinHash) + UI | L | S4-03 | Version fixtures grouped correctly; false-merge rate on distractors reported (< 5%) |
| S4-05 | Richer evidence & match navigation | M | MVP | Up to 3 passages per result; page/section labels; detail-view match stepping |
| S4-06 | OCR opt-in (images, scanned PDFs), bundled language data | L | MVP; D-06 | OCR off → zero OCR work; on → image fixture queries found; network guard clean |
| S4-07 | Embedding model change flow (dual space) | M | S4-03 | Search available throughout; swap atomic; old vectors removed |
| S4-08 | Global shortcut, opt-in history, throttle modes | M | MVP | History off by default; clear works; shortcut configurable |
| S4-09 | Storage reduction (only if S3-08 shows need) | M | S3-08 | Quality loss ≤ 0.01 Recall@10; size reduction measured |

## Stage 5 — Contextual discovery

| ID | Title | Size | Depends on | Key acceptance |
|---|---|---|---|---|
| S5-01 | Content vectors + Related panel | M | S4-04 | ≥ 70% labelled related pairs in top-5 |
| S5-02 | Version compare (text diff view) | M | S4-04 | Fixture version diffs highlight changed terms; keyboard navigation |
| S5-03 | Discover screen: possibly forgotten, project groups | L | S5-01 | Groups stable across reindex; user rename persisted |

## Stage 6 — Ask your files

| ID | Title | Size | Depends on | Key acceptance |
|---|---|---|---|---|
| S6-01 | Chat provider (stream, JSON schema, abort, `num_ctx`) + cancellation verification + model bake-off harness | M | MVP; D-04 | Cancellation behaviour documented; candidates measured on QA set |
| S6-02 | Ask pipeline: retrieval, diversification, prompt, validation, abstention, conflicts | L | S6-01, S4-03, S4-04 | Citation validity 100% after validation; abstention gate works |
| S6-03 | Ask UI | M | S6-02 | Streaming, stop, sources, inference labels, conflict notice, memory-insufficient state |
| S6-04 | QA eval + injection suite + memory checks | M | S6-02 | Targets in [07 §12](07-testing-and-acceptance.md) |

## Stage 7 — Assisted actions

| ID | Title | Size | Depends on | Key acceptance |
|---|---|---|---|---|
| S7-01 | Action model, executor in main, action log, undo | L | S5-03; security review | Executor is the only write path (lint rule + test); stale-plan detection; Recycle Bin only |
| S7-02 | Deterministic suggestion generators | M | S7-01 | Suggestions reproducible; no LLM in decision path |
| S7-03 | Review UI + E2E on temp folders | M | S7-02 | No default selection; per-item preview; undo verified |

---

## First ten items (execution order)

1. S0-01 Repository initialisation and ADRs
2. S0-02 Toolchain skeleton with pinned versions
3. S0-03 Native module and process-model spike
4. S0-08 Evaluation corpus v0 and pilot queries *(can run in parallel with 3–5; needs D-09)*
5. S0-04 Ollama integration probe *(needs D-03)*
6. S0-05 Vector search benchmark
7. S0-07 Windows filesystem spike
8. S0-09 Extraction spike
9. S0-06 Embedding model candidates (pilot)
10. S0-10 Stage 0 report and target revision
