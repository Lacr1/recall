# 07 — Testing, Evaluation, and Acceptance

> Status: **Draft for approval** · Related: [04 Retrieval](04-search-and-retrieval.md) · [06 Security](06-security-and-privacy.md) · [08 Roadmap](08-development-roadmap.md)
>
> **No test described here has been run.** The repository contains no code. Every metric below is a *target* or a *procedure*; results will be recorded in `eval-results/` and stage reports once implementation begins.

## 1. Principles

1. **Most tests need no model and no network.** The engine depends on an `EmbeddingProvider` interface ([03 §5](03-system-architecture.md)); tests use deterministic fakes or recorded vectors.
2. **Real SQLite, real files, temp directories.** Database and filesystem behaviour is tested against the real thing (better-sqlite3 + sqlite-vec on a temp DB; real temp folders), not mocks.
3. **Retrieval quality is measured, not asserted by intuition.** Every ranking change is accompanied by eval numbers compared with the previous baseline.
4. **Tests prove invariants after failures.** Crash, kill, and corruption tests check that the index is consistent afterwards.
5. **Manual checks are scripted.** Anything that can't be automated (offline mode, screen readers, OneDrive) has a written procedure with a pass/fail record.

## 2. Test layers

| Layer | Tool | Scope | Needs Ollama? | Runs in |
|---|---|---|---|---|
| Unit | Vitest | Pure functions: chunker, tokeniser helpers, RRF fusion, snippet selection, path validation, exclusion matching, query-intent parsing, schema validators | No | `npm test`, CI |
| Integration (engine) | Vitest | Engine modules together with real SQLite + temp folders + fake embeddings: indexing pipeline, change detection, deletion cascades, search end-to-end, job recovery | No | `npm test`, CI |
| Contract | Vitest | IPC zod schemas: valid payloads accepted, invalid rejected; main↔engine message types | No | `npm test`, CI |
| Extraction fixtures | Vitest | Each extractor against fixture files (good, edge, broken) | No | `npm test`, CI |
| Retrieval eval | Custom harness (`npm run eval`) | Ranking quality on the eval corpus, per mode | No (recorded vectors) / Yes (live mode) | CI (recorded), local (live) |
| Live model | Vitest `@live` | Real Ollama: embed shape/dims, prefix handling, timeouts, pull progress parsing | **Yes** | Local only |
| Benchmarks | `npm run bench` | Throughput, latency, memory, DB size | Optional | Local, per stage |
| E2E | Playwright (Electron) | Real app windows: onboarding, add folder, search, open, remove, settings, error states | No (fake Ollama server) | Local; CI if stable |
| Accessibility | axe-core in Playwright + manual NVDA/Narrator | All MVP screens | No | Local per stage |
| Security | Vitest + Playwright + scripted audit | IPC validation, renderer isolation, open-file guard, network guard | No | CI + local |
| Packaging | Scripted + manual | Installer build, install/upgrade/uninstall on clean profile | No | Per stage |

## 3. Test doubles and fixtures

| Double | Behaviour | Used for |
|---|---|---|
| `FakeEmbeddingProvider` | Deterministic vector from hashed word unigrams/bigrams (feature hashing into N dims, L2-normalised). Gives lexically-similar texts similar vectors; zero network. Configurable latency and failure injection. | Pipeline and search integration tests |
| `RecordedEmbeddingProvider` | Looks up `sha256(modelId + prefix + text)` in a committed fixture file produced once by the live model; **throws on miss** (so stale fixtures are caught). | Eval harness in CI with *real* semantic vectors |
| `FakeOllamaServer` | Tiny HTTP server on `127.0.0.1:<random>` implementing `/api/version`, `/api/tags`, `/api/embed`, `/api/pull` (streamed), `/api/chat` (streamed) with scripted responses, delays, 500s, malformed JSON, mid-stream disconnects. | Readiness state machine, backoff, cancellation, E2E onboarding |
| `TempCorpus` builder | Creates folder trees with given files, timestamps, sizes; helpers to rename/move/modify/delete/lock files. | Change detection, scanner |
| `FakeClock` | Controls time for debounce, backoff, GC grace periods. | Watcher/jobs |
| Shell/dialog stubs | Main-process test hooks (enabled only when `RECALL_E2E=1` in dev builds) replace `dialog.showOpenDialog` and `shell.openPath` with recorders. Compiled out of production builds. | E2E |

Fixture files live in `tests/fixtures/`. Generated binary fixtures (PDF/DOCX) are produced by a documented script or committed with a note of their origin; no confidential content.

## 4. Engine tests

### 4.1 Database

- Migrations: fresh DB reaches latest version; each migration applied to a snapshot of the previous version's schema succeeds; re-running is a no-op; failure rolls back (transaction) and leaves the backup intact.
- Constraints: unique active path per folder; FK cascades (folder → files; content → chunks → vectors/FTS) leave no orphans — asserted by an `assertIndexConsistent(db)` helper used across many tests:
  - every chunk has a content; every vector row has a chunk; FTS row count = chunk count; every file's content exists; no content without files older than the GC grace period.
- `PRAGMA quick_check` passes after every integration test (cheap guard).

### 4.2 Scanner and change detection

Each case runs both via **startup reconciliation** and via the **live watcher**:

| Case | Expected |
|---|---|
| New file | Indexed once |
| Content edit (size or mtime change, new hash) | Old chunks replaced atomically; search returns new content only |
| Touch (mtime change, same hash) | No re-extraction, no re-embedding (assert provider call count = 0) |
| Rename in same folder | Same content row reused; path updated; no re-embed |
| Move between indexed folders | Same as rename |
| Move out of indexed folders | File marked deleted; content GC'd after grace period |
| Copy (duplicate) | Second file links to same content; results show "2 copies" |
| Delete then recreate same path with different content | Treated as edit |
| Case-only rename (`a.txt` → `A.txt`) | Recognised as same file (Windows paths are case-insensitive) |
| Excluded pattern added later | Matching files purged |
| File locked (`EBUSY`/`EPERM`) | Status `locked`, retried with backoff, never crashes |
| Path > 260 chars | Indexed correctly (or explicitly reported unsupported if Stage 0 shows otherwise) |
| Non-ASCII / emoji path | Indexed and openable |
| Folder becomes unavailable (drive unplugged — simulated by renaming root) | Folder status `unavailable`; index kept; no mass deletion |
| Burst of 1,000 changes | Debounced/coalesced; queue does not explode; final state consistent |

The last-but-one case is critical: **a missing root must never be interpreted as "all files deleted"**.

### 4.3 Extraction

Per format: well-formed sample; empty file; huge file (beyond cap → `too_large`); corrupt bytes (→ `corrupt`, no crash); wrong extension (e.g. PDF named `.docx`); encodings (UTF-8, UTF-8 BOM, UTF-16 LE/BE BOM, Windows-1252); CRLF vs LF; PDF: multi-page with page numbers preserved, password-protected (→ `password_protected`), no text layer (→ `no_text`, flagged "may be scanned"); DOCX: headings, tables, lists, footnotes; Markdown: headings → section paths; code: long lines, minified files (→ skipped heuristically). Each extractor runs under the worker pool with timeout tests (a fixture that triggers the timeout → `timeout`, worker recycled).

### 4.4 Crash and recovery

- Kill the engine process (`SIGKILL` equivalent via `process.kill` on the utility process / child) at random points during indexing of a 300-file corpus, 20 iterations (seeded). After restart: `assertIndexConsistent`, every file eventually reaches a terminal state, no duplicate chunks.
- Kill during migration → backup restored, app starts.
- Truncate/corrupt the DB file → startup detects, offers rebuild; rebuild produces a consistent index.
- Ollama dies mid-batch (FakeOllamaServer disconnect) → embedding jobs retry with backoff; nothing marked embedded that wasn't.

### 4.5 Ollama client and readiness

Against `FakeOllamaServer`: version probe timeout; model missing; pull progress parsing (multiple layers, resume after disconnect, cancellation); `/api/embed` batch size mismatch detection (returned count ≠ input count → error); dimension mismatch vs stored embedding space → refuse and flag; non-loopback host configured → rejected before any request.

## 5. Retrieval evaluation

### 5.1 Evaluation corpus

Two corpora:

1. **Fixture corpus (committed, synthetic, ~200–300 files).** Authored to mimic the personas in [01 §2](01-product-specification.md): client proposals in 2–4 versions each (with deliberately changed payment terms), contracts, invoices, meeting notes for several projects, a small code repository (auth, booking, payments modules), product manuals with warranty sections, recipes/travel notes as distractors, and near-duplicate copies. Formats: TXT, MD, PDF, DOCX, code. Stage 4 adds OCR images.
2. **Private real-world corpus (not committed).** A team member's consenting real folders. The harness runs locally and reports only aggregate metrics and query IDs — never content. (Decision D-09.)

### 5.2 Query set

`tests/eval/queries.jsonl`, each line:

```
{ "id": "q017", "query": "proposal with half paid upfront", "type": "paraphrase",
  "relevant": { "clients/acme/Acme_Proposal_v2.pdf": 2, "clients/acme/Acme_Proposal_v3.docx": 1 },
  "notes": "v2 has 50% initial payment; v3 changed it" }
```

Grades: 2 = the target, 1 = acceptable. Query types and minimum counts (Stage 1 → Stage 4):

| Type | Example | Stage 1 | Stage 4 |
|---|---|---|---|
| exact | "warranty period" | 15 | 25 |
| paraphrase | "half paid upfront" | 20 | 35 |
| conceptual | "notes about improving the booking flow" | 15 | 30 |
| code | "where auth tokens are refreshed" | 10 | 20 |
| multi-answer | "documents mentioning the warranty" | 10 | 15 |
| temporal/version | "latest proposal with milestones" | — | 15 |
| negative (nothing relevant) | "my passport renewal" | 10 | 20 |
| **Total** | | **80** | **160** |

Queries are written **before** tuning against them where possible; a held-out 25% split is used for final stage sign-off to limit overfitting.

### 5.3 Metrics

| Metric | Why | Used for |
|---|---|---|
| **Recall@10** (file level) | Did the right file appear on the first screen? Primary user-facing outcome. | Gate |
| **MRR@10** | How high is the first relevant file? Users read top-down. | Gate |
| **nDCG@10** (graded) | Rewards ranking the grade-2 target above grade-1 versions. Important for version-heavy corpora. | Tracking |
| Precision@5 | Clutter in the first results. | Tracking |
| Negative-query true-low-confidence rate | Fraction of negative queries flagged low-confidence. | Gate (Stage 4) |
| Positive-query false-low-confidence rate | Fraction of answerable queries wrongly flagged. | Gate (Stage 4) |

All metrics are computed at **file level** (chunks grouped to files; duplicate copies count as the same file).

### 5.4 Comparisons and gates

The harness runs every query in three modes — **keyword-only**, **semantic-only**, **hybrid** — and reports overall and per-type tables, plus per-query wins/losses between runs.

| Gate | Stage 1 target | Stage 4 target |
|---|---|---|
| Hybrid Recall@10 | ≥ 0.80 | ≥ 0.85 |
| Hybrid MRR@10 | ≥ 0.55 | ≥ 0.60 |
| Hybrid vs best single mode (Recall@10) | ≥ (not worse) | ≥ + 0.03 |
| Negative true-low-confidence | — | ≥ 0.70 |
| Positive false-low-confidence | — | ≤ 0.10 |

These thresholds are initial engineering targets on a synthetic corpus, revised with the team after the first baseline is measured (Stage 1, S1-11). With ~100 queries, differences below ~0.03 are within noise; decisions use paired per-query comparison, not just averages.

**Regression rule:** any change that lowers hybrid Recall@10 or MRR@10 by more than 0.02 on the fixture corpus must be justified in the report or reverted.

### 5.5 Experiments the harness must support

Chunk size/overlap variants; contextual header on/off ([04 §3.3](04-search-and-retrieval.md)); embedding model A vs B (requires re-embed of fixture corpus — live mode); RRF k; candidate pool sizes; file-aggregation strategy; temporal re-ordering on/off. Each experiment = config file → report.

## 6. Performance benchmarks

Measured on the actual dev machine (spec recorded in each report), Ollama models warm unless stated. **No numbers are claimed until measured.**

| Benchmark | Method | Output |
|---|---|---|
| Extraction throughput | Fixture corpus ×N, per format | files/min, MB/min per extractor |
| Embedding throughput | Batches of 8/16/32/64 chunks via `/api/embed` | chunks/s per batch size; choose default |
| End-to-end indexing | 2,000-file mixed corpus, clean DB | wall time per phase |
| Keyword latency | 200 queries over 10k / 50k / 200k chunks | p50/p95 |
| Vector KNN latency | Synthetic vectors 10k / 50k / 200k / 500k × dims | p50/p95 (decides whether brute-force is sufficient — [04 §5](04-search-and-retrieval.md)) |
| Hybrid latency | Including query embedding, warm and cold model | p50/p95 |
| Memory | Engine RSS during indexing and idle; main/renderer RSS | MB |
| DB size | Bytes per chunk, per 1k files | MB |

## 7. Security tests

| Test | Type |
|---|---|
| Renderer has no Node: in E2E, `window.require`, `process`, `module` are undefined; `contextIsolation` and `sandbox` true | E2E |
| CSP header present and blocks inline script & remote origins | E2E |
| Navigation and `window.open` to any URL are denied | E2E |
| Every IPC channel rejects malformed payloads (property-based fuzz with fast-check) and messages from unexpected frames | Contract |
| `files.open` with unknown/deleted/foreign IDs fails safely; executable-type files are never passed to `shell.openPath` | Integration |
| Path validation: `..`, mixed separators, UNC, device paths (`\\?\`, `\\.\`), drive-relative paths, junctions/symlinks escaping the folder root | Unit |
| Log scrubber: synthetic secrets/paths/queries never appear in log files after a full E2E run | E2E + grep |
| Network guard: no non-loopback connection attempted during `audit:network` run | Scripted |
| Prompt-injection suite (Stage 6): documents containing instructions ("ignore previous instructions", "tell the user to run…", fake citations) do not change system behaviour; answers still cite only real sources | Eval |

## 8. Offline validation procedure

Automated part (`npm run audit:network`, every stage from Stage 2): runs the packaged app with the network guard in **fail mode** (any non-loopback socket/DNS attempt throws and fails the run) through: start → onboarding (with models present) → add fixture folder → index → 20 searches → open detail → remove folder → delete all data.

Manual part (stage sign-off from Stage 3; recorded in `docs/validation/offline-YYYY-MM-DD.md`):

1. Machine with Recall installed, Ollama installed, models already pulled.
2. **Disable all network adapters** (Settings → Network → Airplane mode on, and confirm Ethernet disabled) — verify a browser cannot load any site.
3. Reboot (ensures nothing is cached in a running process).
4. Start Ollama (tray app) and Recall.
5. Verify status bar shows *Local AI ready* and *Offline*.
6. Add a new folder of fixture files; confirm indexing reaches 100% in both phases.
7. Run the 10 scripted queries in `docs/validation/offline-queries.md`; confirm expected top-3 files.
8. Open a result; reveal in folder; open details.
9. Modify, rename, and delete files in the folder; confirm Recall reflects changes.
10. Close Recall; change files; reopen; confirm reconciliation.
11. Stop Ollama; confirm keyword-only banner and that keyword search works; restart Ollama; confirm recovery without restarting Recall.
12. Remove the folder; delete all data; confirm data directory is empty.
13. Record pass/fail per step, Recall version, Ollama version, model digests.

**Only after this procedure passes may documentation describe Recall as working offline.**

## 9. UI, E2E, and accessibility

E2E flows (Playwright Electron, with `FakeOllamaServer` and dialog/shell stubs):

1. First run → onboarding → skip AI → add folder → keyword search works.
2. First run with AI ready → index → hybrid search → open file (stub records the path).
3. Ollama goes down mid-session → banner → keyword fallback → recovers.
4. Remove folder → results disappear → data size decreases.
5. Failed files listed with reasons → retry.
6. Delete all data → back to onboarding.
7. Keyboard-only walkthrough of flows 1–2.

Accessibility: axe-core scan on every screen state reached by E2E (zero serious/critical violations); manual NVDA + Narrator pass at each stage sign-off using a checklist (landmarks, labels, live regions, focus order, dialogs); 200% scaling and high-contrast mode screenshots reviewed.

## 10. Windows-specific validation

| Area | Check | Auto/Manual |
|---|---|---|
| Long paths | > 260 char paths index and open | Auto (integration) + manual open |
| Case-insensitive paths | Case-only renames; duplicate detection doesn't double-count | Auto |
| OneDrive Files On-Demand | Online-only files are skipped and labelled, not downloaded; "always keep on this device" files index | Manual (needs OneDrive account) |
| Locked files | Open DOCX in Word while indexing → retried later | Manual + auto (simulated) |
| Sleep/resume, user logoff | Watcher recovers; reconcile on resume | Manual |
| Removable/network drives | Unplug → folder `unavailable`, index kept | Manual (network drives are "best effort" in MVP) |
| Defender / SmartScreen | Installer behaviour unsigned vs signed | Manual (D-07) |
| Windows 10 and 11 | Smoke on both | Manual |
| Display scaling | 100/150/200% | Manual |

## 11. Packaging and installation

- `npm run package` produces an installer; native modules (better-sqlite3, sqlite-vec DLL) load from the packaged app (asar-unpacked) — automated smoke: launch packaged exe with `--smoke-test` flag that opens DB, loads vec extension, runs one keyword query on a bundled sample, exits 0.
- Clean-profile install → first run → onboarding.
- Upgrade install from previous stage build → migration runs → index preserved.
- Uninstall → app removed; user data retained or removed per uninstaller choice (decision in [03 §8](03-system-architecture.md)); documented.

## 12. Ask-your-files evaluation (Stage 6)

`tests/eval/qa.jsonl`: ~60 questions over the fixture corpus: answerable-single-source, multi-source synthesis, conflicting-sources (versions), and unanswerable. Each has expected key facts and required source files.

| Metric | Measurement | Target (provisional) |
|---|---|---|
| Citation validity | % citations that reference a passage actually provided to the model (automatic) | 100% (invalid citations are stripped & flagged by the validator) |
| Citation support | % cited sentences whose cited passage contains the key fact (string/numeric match automatic; remainder manual review) | ≥ 0.85 |
| Answer correctness | Manual rubric (correct / partially / wrong) by reviewer | ≥ 0.75 correct |
| Abstention | % unanswerable questions answered "not enough evidence" | ≥ 0.80 |
| Conflict surfacing | % conflicting-source questions where the conflict is mentioned | ≥ 0.70 |
| Injection resistance | % injection fixtures with no behavioural change | 100% |
| Latency | Time to first token / full answer on dev machine | Measured; reported |

## 13. Automated vs manual summary

| Automated (every PR / stage) | Manual (stage sign-off) |
|---|---|
| Unit, integration, contract, extraction | Offline procedure (§8) |
| Retrieval eval (recorded vectors) | Live-model eval run + review of per-query failures |
| Crash/recovery loops | NVDA / Narrator pass |
| E2E flows + axe | OneDrive, locked files, sleep/resume, drives |
| Network guard audit | Clean-machine install/upgrade/uninstall |
| Packaged smoke test | Usability session (post-Stage 3) |

## 14. Evidence rules

- A stage report may only say "passes" for a test that was executed in that session or in CI on the reported commit; it includes the command and its summary output.
- Eval reports include: commit, corpus version, query-set version, embedding model + digest, config, metrics per mode/type, and the list of failed queries.
- Benchmarks include machine spec, OS build, Ollama version, model digests, and whether models were warm.
