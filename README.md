# Recall

**Your computer should remember what you forgot.** Recall is a local-first desktop app that finds your files by what they *meant*, not their names. It shows the passage that matched and opens the original. It can also answer questions from your files with citations. Everything runs on your computer through [Ollama](https://ollama.com); after setup, nothing needs the internet.

> Status: **hackathon build (0.1)**, a cut-down version of the plan in [docs/app-plan](docs/app-plan/README.md). What was verified, and how, is in [docs/validation/hackathon-build.md](docs/validation/hackathon-build.md).

## Requirements

- Windows 10 22H2+ or Windows 11 (x64)
- Node.js 22.12+ (developed on 24.21)
- [Ollama](https://ollama.com/download/windows) running, with models:
  - `ollama pull nomic-embed-text` (search by meaning, 274 MB, required for semantic search)
  - `ollama pull qwen2.5:3b` (optional, for **Ask**; research licence, demo only; see plan decision D-04)

Without Ollama, Recall still works in **keyword-only** mode and says so.

## Run

```
npm ci
node scripts/fetch-voice-models.mjs   # once: voice models into resources/voice (about 160 MB, checksums pinned)
npm run dev          # development, hot reload
npm run build && npm start   # production build
npm run package      # Windows installer -> dist/Recall-Setup-0.1.0.exe (unsigned)
```

Index data lives in `%LOCALAPPDATA%\Recall\data` (override with `RECALL_DATA_DIR`). Settings → *Delete all Recall data* removes it. Your files are never modified.

## Test

```
npm test             # 216 unit + integration tests incl. a 20-kill crash loop; no model or network needed
                     # (CRASH_SEED=<n> npm test picks other kill points)
npm run test:live    # needs Ollama: retrieval eval (writes eval-results/latest.md) + Ask checks;
                     # also the voice models on synthetic speech (needs resources/voice)
npm run test:e2e     # builds, then drives the real app with a fake Ollama: 34 flows (20 voice: fake mic, popup, onboarding) + accessibility scans
                     # (RECALL_E2E_EXE=dist/win-unpacked/Recall.exe npx playwright test runs them on the packaged app)
npm run audit:network  # needs Ollama: full app flow, fails if anything connects outside this computer
                       # (RECALL_AUDIT_EXE=dist/win-unpacked/Recall.exe audits the packaged app)
npm run bench        # vector search speed/memory at 10k-200k chunks (eval-results/bench-vectors.md)
npm run typecheck
npm run fixtures     # regenerate the synthetic corpus in tests/fixtures/corpus
```

Smoke test of the real app (engine process, renderer, searches), optionally with screenshots:

```
electron . --smoke-test=<folder> [--smoke-screenshots=<dir>]
electron . --voice-smoke=tests/fixtures/voice/recall-find-my-resume.wav   # voice process: wake word + transcript
```

## Demo script (≈ 3 minutes)

1. Start Ollama. Launch Recall. On first run, onboarding shows the privacy promise, then the local-AI check, then folder selection. Add `tests/fixtures/corpus` (a synthetic set of a freelancer's files) or a real folder that does not sync to OneDrive.
2. Watch **Reading files** then **Understanding** progress. Searching works immediately.
3. Search `proposal with a 50% initial payment` → `Acme_Proposal_v2.pdf` on page 2, with the passage highlighted and *why it matched*.
4. Search `emails landing in junk folder` → the retro note says "go to spam"; it matches by meaning, with no shared keywords.
5. Search `version with the payment milestones` → v3. It shows "2 copies" because a duplicate sits in Downloads.
6. **Details** → full extracted text with match navigation. **Open** opens the original file.
7. **Ask**: `What payment terms did I propose to Acme, and did they change?` → a cited answer: 50% → 40/30/30, with the newer file noted.
8. Ask `When does my passport expire?` → Recall declines, because there isn't enough evidence.
9. **Folders**: failures are shown in plain language (damaged PDF, scanned PDF with no text). **Settings**: local AI status, data location and size, delete all data.
10. Stop Ollama. Recall falls back to keyword search and shows a banner. Restart Ollama and it recovers on its own.

## Architecture (short)

```
Renderer (React, sandboxed, no Node)  ──typed IPC──▶  Main (window, dialogs, open-file guard)
                                                        │ MessagePort RPC
                                                        ▼
                                  Engine utilityProcess: SQLite (FTS5 + vectors), scanner,
                                  extract (pdf.js, mammoth), chunker, hybrid search, Ask
                                                        │ HTTP, 127.0.0.1 only
                                                        ▼
                                              Ollama (nomic-embed-text, qwen2.5:3b)
```

The search pipeline combines keyword (BM25) results, all-terms keyword results, meaning (cosine) results and file-name matches with Reciprocal Rank Fusion. Results are grouped per file, identical copies are collapsed, and each result carries a deterministic match reason. Details are in [docs/app-plan/04-search-and-retrieval.md](docs/app-plan/04-search-and-retrieval.md).

## License

Recall's code is released under the [MIT License](LICENSE).

The voice models shipped with the installer have their own licences, listed in [resources/voice/NOTICE.md](resources/voice/NOTICE.md). The AI models Recall uses through Ollama are downloaded separately and keep their own licences: `nomic-embed-text` is Apache-2.0, and `qwen2.5:3b` is under the Qwen research licence, which does not allow commercial use.

## Credits

- The Ollama, Nomic and Qwen logos in Settings belong to their owners and are shown only to name the software Recall works with. Their use does not imply endorsement.
- Local AI runs through [Ollama](https://ollama.com). Embeddings come from [Nomic](https://www.nomic.ai) `nomic-embed-text`, and Ask uses [Qwen](https://github.com/QwenLM/Qwen2.5) `qwen2.5:3b`.
- On-device voice uses [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), with the models credited in [resources/voice/NOTICE.md](resources/voice/NOTICE.md).
