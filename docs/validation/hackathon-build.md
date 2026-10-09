# Hackathon build: what was built and what was verified

> Date: 2026-10-09, updated 2026-10-10 for the voice assistant, search page, frameless window and red panda branding · Machine: Windows 10 Pro 19045, AMD Ryzen 7 5700G (iGPU), 15.4 GB RAM · Ollama 0.40.2 · Electron 44.7.0 (Node 24.21.0)
>
> Decision D-13: the hackathon deadline is **2026-10-10**. This build is a one-day cut of the plan, not the MVP defined in [01 §7](../app-plan/01-product-specification.md). Decisions taken: D-02 = this PC is the benchmark machine; D-03 = `nomic-embed-text` only (pulled); D-09 = synthetic corpus only.

## Scope delivered

| Area | Delivered | Differs from plan |
|---|---|---|
| Processes | Engine in `utilityProcess`; sandboxed renderer; typed preload API; main validates sender + params | Manual validation instead of zod |
| Storage | SQLite (better-sqlite3 13), content-addressed schema, FTS5 (porter) for chunks + file names | Vectors searched **in memory in JS** (exact cosine), not via sqlite-vec — ADR-006 fallback option; fine at demo scale |
| Formats | TXT, Markdown, code/config files, PDF (pdf.js 6 legacy), DOCX (mammoth). Optional OCR (S4-06, off by default): images and PDFs without a text layer, tesseract.js with bundled English data | Extraction in the engine's event loop with a timeout, not in worker threads (OCR runs in tesseract's own worker thread) |
| Indexing | Two-phase (keyword first, then meaning), reconcile scan with generations, `fs.watch` recursive + debounce, periodic reconcile, hash dedupe, rename without re-embedding, GC, pause/resume, retry | No placeholder (OneDrive) detection; `@parcel/watcher` not used |
| Search | RRF over keyword-any, keyword-all, meaning, and file-name lists; meaning-only results trimmed by a cosine margin; snippets with highlights; match reasons; duplicate collapse; low-confidence flag. Stage 4 (2026-10-10): type, folder and date filters applied inside every candidate list, with removable chips (S4-01); time words in the query ("latest", "last week", "in March", "2025") become a newest-first RRF list or a date-filter chip, and filters or time words alone list matching files newest first (S4-02); "Show in document" opens the detail view at a passage, and passages and matched words can be stepped through (F3 / Shift+F3) (S4-05); version families shown as one result with "N versions" (S4-04); switching the embedding model rebuilds in the background with search still working (S4-07); int8 vectors in memory with float32 re-scoring (S4-09). Stage 4 eval: 238-file corpus, 168 queries (S4-03). See [s4-search.md](s4-search.md) | S4-08 (global shortcut, history, throttle modes) left out. Two 07 §5.4 gates missed on the Stage 4 eval: negative low-confidence 0.60 (target 0.70) and hybrid over best single mode +0.02 on holdout (target +0.03). Low-confidence rule and version thresholds revised from the plan's starting values (see s4-search.md) |
| Ask | Grounded answers from top passages with `qwen2.5:3b`, streamed, numbered citations validated, abstention marker, "Inferred:" labelling | No JSON-schema output or quote verification (plan §9) |
| UI | Frameless window with its own title bar; splash screen; five-step onboarding (Welcome, Local AI, Folders, Voice, Ready) with one-click Documents/Desktop/Downloads picks; search + evidence with example searches drawn from the user's own files, recent searches (local storage, cleared by delete-all) and loading skeletons; document detail, Ask, Folders, Settings (AI status, search model switch, text in images, data size, delete all data), status bar; red panda logo, app icon and animated search mascot | No global shortcut |
| Voice ([plan 12](../app-plan/12-voice-assistant.md), [ADR-0015](../adr/0015-on-device-voice.md)) | Off by default. "Recall" wake word, end-of-speech detection and speech-to-text (Moonshine tiny) via sherpa-onnx in a separate supervised `utilityProcess`; mic audio goes straight to it over a `MessagePort`, never to disk. Popup near the pointer that never takes focus (red panda summon animation): finds a file and copies its path, "the second one", Show in folder, folders, Open in Recall, spoken questions answered with citations, local-only read-aloud. Weak matches copy nothing until the user picks (D-26). Tray, close-to-tray, mute, wake sensitivity, Start with Windows, onboarding step and Settings panel | S8-01…S8-10 done; S8-11 (validation on real voices) and S8-12 (regression and plan docs) not done |
| Security | contextIsolation, sandbox, CSP, navigation/window/permission denial (audio-only mic grant, video denied), renderer network blocked, loopback-only socket-level guard in main and engine, no proxy auto-detection, open-file guard (IDs, realpath, root check, executable denylist), blocked system/AppData folders | No fuses set; no firewall-log audit performed |
| Packaging | electron-builder NSIS per-user installer, unsigned: 138 MB before voice, 281 MB with the bundled voice models, **291.7 MB** with OCR (2026-10-10) | — |

## Verification evidence

Run on 2026-10-09 unless a row says otherwise.

> **Re-run before the demo:** `dist/` (installer and `win-unpacked`) was built at 22:22 on 2026-10-09, before the frameless window, red panda branding and popup summon commits. The E2E, network audit and packaged smoke rows predate those commits too. Rebuild with `npm run package`, then repeat those three rows on the new `Recall.exe`.

| Check | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | pass (2026-10-10, `development` at 3dedd62) |
| Unit + integration (no model, network guard on) | `npm test` | **293 / 293 passed** in 20 files (2026-10-10, `development` at 3dedd62 plus uncommitted indexing and Stage 4 changes). Was 45 in the first cut; voice, search page, window, indexing-rule and Stage 4 tests added since |
| Voice process (S8-02) | `electron . --voice-smoke=tests/fixtures/voice/recall-find-my-resume.wav`, `npm run test:live` | dev build and packaged `Recall.exe`: wake word heard, "Find my resume." transcribed, guard audit log empty. Live voice test 4/4. Packaged voice process 140 MB idle, 278 MB after a request |
| Voice E2E (S8-03…S8-10) | `npm run test:e2e` (fake mic via `RECALL_FAKE_MIC`) | `voice.spec.ts` 8/8 and `voice-popup.spec.ts` 10/10 on the built and packaged app; popup never takes focus; axe clean on popup states. See [plan 12 §9](../app-plan/12-voice-assistant.md#9-stage-8-backlog) |
| Network audit (S3-07, automated part) | `npm run audit:network` | built and packaged app: zero non-loopback connections or lookups across guard log, Chromium net log and Windows TCP table. See [network-audit-2026-10-09.md](network-audit-2026-10-09.md) |
| Crash loop (S1-08) | `npm test`, `CRASH_SEED=<n>` | 20 kills per run, 8 seeds: always consistent, final index identical to a clean one. See [s1-08-crash-loop.md](s1-08-crash-loop.md) |
| Retrieval eval, live model | `npm run test:live` → `eval-results/latest.md` | see below |
| Ask, live model | `npm run test:live` (ask.test.ts) | 2 / 2 passed: cited answer for the Acme payment question (17.7 s); abstained on "When does my passport expire?" (6.5 s) |
| App smoke (dev build) | `electron . --smoke-test=tests/fixtures/corpus` | exit 0; 18 files, 29 chunks, all 3 queries correct top file, 32–37 ms; no renderer errors |
| App smoke (dev server) | `npm run dev -- --smoke-test=…` | ok (renderer loads under CSP with HMR) |
| App smoke (**packaged** `Recall.exe`) | `dist/win-unpacked/Recall.exe --smoke-test=…` | exit 0; same results |
| Visual check | `--smoke-screenshots` | 7 screens captured and reviewed |
| End-to-end + accessibility (S2-11) | `npm run test:e2e` | **14 / 14 passed** on the built app and on the packaged `Recall.exe`; axe: 0 findings at any severity on 17 screen states. See [s2-11-e2e.md](s2-11-e2e.md). 2026-10-10, with all of Stage 4: **39 / 39 passed** on the built app and on the packaged `Recall.exe`, including filters, versions, passages, model switch and OCR, with axe on the new screens |
| Recovery (S3-04) | `npm test`, `npm run test:e2e` | damaged index → notice → rebuild from the same folders; failed upgrade → backup restored; engine killed during indexing → restarts, index consistent; repeated crashes → "Restart indexer". See [s3-04-recovery.md](s3-04-recovery.md) |

### Retrieval eval (synthetic corpus, 18 files, 20 answerable + 5 negative queries, nomic-embed-text)

| Mode | Hit@5 | Recall@5 | MRR@10 |
|---|---|---|---|
| keyword only | 0.95 | 0.95 | 0.89 |
| meaning only | 0.95 | 0.94 | 0.90 |
| hybrid, plain RRF (baseline) | 1.00 | 1.00 | 0.85 |
| **hybrid as shipped** (+ all-terms list, meaning margin 0.10) | **1.00** | **1.00** | **0.95** |

- 2026-10-10, with Stage 4: hybrid as shipped is now Hit@5 0.95, Recall@5 0.95, MRR@10 0.93. One query's target (Acme v2) is listed under another version's result, which this harness doesn't score. The larger Stage 4 eval ([s4-search.md](s4-search.md)) replaces this set for Stage 4 decisions.
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
- The automated network audit passes (no connections leave the machine in normal use), but the manual offline run with adapters off and the Windows Firewall log audit have not been done.
- **Not exercised by automation:** the native folder picker dialog itself (E2E replaces it) and the "Start Ollama" button. The model download flow and Ollama stopping mid-session are covered by E2E against a fake Ollama; check both once by hand with the real one before the demo.
- **OneDrive online-only files are not detected** (S3-03 skipped). Indexing a OneDrive-synced folder may make Windows download those files. For the demo, use `tests/fixtures/corpus` or a folder that is not synced.
- The network audit passed again on 2026-10-10 with all of Stage 4 (built app): 8 connection attempts, all loopback, none blocked. An earlier run that day failed only because Ollama was busy (16–21 s per embedding).
- Large real-world folders have not been tried. Expect roughly 7 chunks/s for the meaning phase on this CPU.
- `qwen2.5:3b` is research-licensed: fine for the demo, not as a shipped default (D-04).
- **Voice has only been tested on synthetic speech** (Windows voices, Chromium's fake mic). Real voices, a laptop mic in a noisy room, the hour-long false-wake run, NVDA/Narrator, hearing read-aloud, and "Start with Windows" on an installed build are all S8-11 and not done. Try the wake word with the demo room's mic before presenting.
- Voice is off by default. Turn it on in onboarding or Settings → Voice for the demo.
- The plan documents ([01](../app-plan/01-product-specification.md), [02](../app-plan/02-ux-and-user-flows.md), [03](../app-plan/03-system-architecture.md), [06](../app-plan/06-security-and-privacy.md), [10](../app-plan/10-risks-and-open-decisions.md)) do not describe voice yet; [plan 12](../app-plan/12-voice-assistant.md) is the source of truth for it (S8-12).
