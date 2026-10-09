# 01 — Product Specification

> Status: **Draft for approval** · Owner: Recall technical lead · Last updated: 2026-10-09
> Related: [02 UX](02-ux-and-user-flows.md) · [08 Roadmap](08-development-roadmap.md) · [10 Risks & decisions](10-risks-and-open-decisions.md)

## 1. Vision

**Recall — "Your computer should remember what you forgot."**

Recall is a local-first memory layer over the files a person already has. It lets them find a document by what it *meant* or *contained* — not by its filename, folder, or exact wording — then understand why it matched, open the original, and (later) ask questions across documents and act on what they find.

Product arc: **Find → Understand → Act.**

| Phase | What the user gets | Delivered in |
|---|---|---|
| **Find** | Natural-language + keyword search over approved folders, ranked files with evidence passages, open original | MVP (Stages 1–3) |
| **Understand** | Better explanations, filters, version/duplicate awareness, related files, grounded multi-document answers with citations | Stages 4–6 |
| **Act** | User-approved suggestions: archive old drafts, review duplicates, rename/group files | Stage 7 |

### 1.1 What Recall is not

- Not a cloud sync or storage product. Files stay where they are; Recall never moves, edits, or deletes a user file without explicit per-action approval (and not at all before Stage 7).
- Not a chatbot-first product. The core is retrieval with evidence. Generation is layered on top and must cite retrieved sources.
- Not a whole-disk crawler. Recall only reads folders the user explicitly adds.
- Not a knowledge-graph platform. No entity graph is built unless a later stage proves a concrete need (see [05 §9](05-data-model-and-indexing.md)).

### 1.2 Local-first as a hard constraint

The hackathon requirement — *"a solution that will still work once the cloud is gone"* — is treated as an architectural rule:

- **After setup, every core workflow runs with no network connection**: folder scanning, extraction, embedding, keyword + semantic search, ranking, evidence display, opening files, re-indexing, settings, and data deletion.
- The only network contact Recall itself makes is to the **local** Ollama server on the loopback interface (`127.0.0.1`). Recall has no accounts, no telemetry, no cloud APIs.
- Internet is needed only for: downloading the installer, installing Ollama, and downloading models (once). Optional later: update checks (off by default, see [06](06-security-and-privacy.md)).
- **Graceful degradation:** if Ollama or a model is unavailable, Recall still provides keyword search over already-extracted text and says clearly what is missing (see §6).

"Offline-capable" is a claim Recall earns only after the offline validation procedure in [07 §8](07-testing-and-acceptance.md) passes. Until then, documents say "designed for offline operation".

## 2. Personas

| Persona | Context | Typical files | Representative need |
|---|---|---|---|
| **Maya — freelance consultant** | Works across ~15 client projects a year; files scattered across Downloads, Documents, OneDrive | Proposals (DOCX/PDF), contracts, invoices, meeting notes (MD/TXT) | "Find the proposal where I offered a 50% initial payment." "Which version had the payment milestones?" |
| **Dev — indie developer** | Several repos and side projects; screenshots of dashboards; notes | Source code, READMEs, Markdown notes, PNG screenshots | "Where did I implement auth?" "The screenshot where I configured Supabase auth." |
| **Sam — small-business owner** | Non-technical; receipts, warranties, supplier PDFs | Scanned PDFs, product manuals, emails saved as PDF | "Which documents mention the warranty period?" "What did we agree with the supplier about delivery?" |

Design target for the UI is **Sam** (non-technical). Design target for search quality is **Maya** (many similar documents and versions). **Dev** stresses file-type breadth.

## 3. Use cases

Each use case is mapped to the stage where it becomes possible. "Retrieval-only" means it needs no LLM.

| ID | Use case (user's words) | Mechanism | Stage |
|---|---|---|---|
| UC-01 | "Find the proposal where I discussed a 50% initial payment." | Hybrid search; evidence passage with highlighted terms | 1–2 (MVP) |
| UC-02 | "Which documents mention the warranty period?" | Hybrid search; list many files, each with passage | MVP |
| UC-03 | "Find the meeting notes about improvements to the booking system." | Semantic search + type filter (notes) | MVP (filter UI Stage 4) |
| UC-04 | "Find the source code file where I implemented authentication." | Semantic + keyword on code files (identifiers) | MVP (code formats), improved Stage 4 |
| UC-05 | "Find the latest proposal after I added payment milestones." | Hybrid search + temporal-intent re-ordering + version grouping | Stage 4 |
| UC-06 | "Find the screenshot of the Supabase dashboard where I configured authentication." | OCR text of images → hybrid search | Stage 4 (optional OCR) |
| UC-07 | "Show me documents related to this project that I may have forgotten." | Related-file discovery from document vectors | Stage 5 |
| UC-08 | "What did I decide about this project, and which files support that?" | Grounded multi-document answer with citations | Stage 6 |
| UC-09 | "Summarize these three files / do they conflict?" | Grounded summarization + conflict flagging | Stage 6 |
| UC-10 | "Help me clean up old drafts / duplicates." | Duplicate & version detection → approval-gated plan | Stage 7 |

## 4. Functional requirements

Priority: **M** = MVP must, **S** = should (post-MVP stage noted), **C** = could.
IDs are referenced from the roadmap and backlog.

### 4.1 Folder management & indexing (FR-IDX)

| ID | Requirement | Pri |
|---|---|---|
| FR-IDX-01 | User adds folders via the OS folder picker. Recall never indexes outside added folders. | M |
| FR-IDX-02 | Default exclusions: hidden/system files, `node_modules`, `.git`, build output dirs, temp/lock files (`~$*.docx`), files > size cap (default 50 MB; PDFs 200 MB). User can add exclusion patterns per folder. | M |
| FR-IDX-03 | Initial indexing runs in the background with visible progress (files found / processed / failed, current phase). | M |
| FR-IDX-04 | Keyword search becomes available for each file as soon as its text is extracted, before embeddings finish. | M |
| FR-IDX-05 | Detect additions, edits, renames/moves, and deletions — while running (watcher) and since last run (startup reconciliation). | M |
| FR-IDX-06 | Unchanged files (same size + mtime) are not re-read; identical content (same hash) is never re-extracted or re-embedded. | M |
| FR-IDX-07 | Per-file failure states (unsupported, password-protected, corrupt, too large, locked, cloud-only placeholder, timed out) are recorded and shown; indexing continues. | M |
| FR-IDX-08 | Retry failed files (single or all). | M |
| FR-IDX-09 | Pause / resume indexing. | M |
| FR-IDX-10 | Remove a folder: stops watching, deletes all its index data (text, chunks, vectors) — files on disk untouched. | M |
| FR-IDX-11 | Rebuild index (per folder or all). | M |
| FR-IDX-12 | Crash-safe: after an unexpected shutdown, indexing resumes without corruption or duplicate data. | M |
| FR-IDX-13 | Does not trigger downloads of OneDrive/Dropbox cloud-only placeholders by default (see [05 §6.4](05-data-model-and-indexing.md)). | M |
| FR-IDX-14 | Index on battery / low-priority mode (throttle). | S (4) |

### 4.2 Search (FR-SRCH)

| ID | Requirement | Pri |
|---|---|---|
| FR-SRCH-01 | Single search box accepting natural language or keywords. | M |
| FR-SRCH-02 | Hybrid ranking (semantic + keyword) with file-level results. Falls back to keyword-only when embeddings are unavailable, and says so. | M |
| FR-SRCH-03 | Each result shows: file name, type icon, folder path, modified date, 1–3 evidence passages with matched terms highlighted, page/section location where known. | M |
| FR-SRCH-04 | Each result shows a deterministic *match reason* (e.g. "Contains 'initial payment'", "Similar meaning on page 3", "Filename match"). | M |
| FR-SRCH-05 | Open original file; reveal in Explorer; copy path. | M |
| FR-SRCH-06 | Empty state, no-match state, and **low-confidence** state ("These are the closest matches, but none strongly match"). | M |
| FR-SRCH-07 | Identical-content copies collapse into one result ("2 copies"). | M |
| FR-SRCH-08 | Superseded queries are cancelled (typing a new query aborts the previous one). | M |
| FR-SRCH-09 | Filters: file type, folder, modified date range. | S (4) |
| FR-SRCH-10 | Temporal intent ("latest", "newest", "last month") influences ordering. | S (4) |
| FR-SRCH-11 | Version grouping of near-duplicate files (e.g. `proposal_v2`, `proposal_final`). | S (4) |
| FR-SRCH-12 | Document detail view: full extracted text with all matches, metadata, index status. | M (basic) / S (4, rich preview) |
| FR-SRCH-13 | Optional, privacy-conscious recent-search history (off by default, clearable). | C (4) |
| FR-SRCH-14 | Global shortcut to open Recall's search window. | S (4) |

### 4.3 Local AI readiness (FR-AI)

| ID | Requirement | Pri |
|---|---|---|
| FR-AI-01 | Detect Ollama: not installed / installed but not running / running; detect required models present. | M |
| FR-AI-02 | Guide the user to install Ollama (link + steps) and download required models with progress (in-app via Ollama's pull API, with explicit consent because it uses the internet). | M |
| FR-AI-03 | Continuous health monitoring; recover automatically when Ollama comes back. | M |
| FR-AI-04 | Settings: choose embedding model (from a vetted list) — changing it triggers a confirmed re-embed. | S (4) |
| FR-AI-05 | Only loopback Ollama endpoints are accepted. | M |

### 4.4 Contextual discovery (FR-DISC) — Stage 5

| ID | Requirement | Pri |
|---|---|---|
| FR-DISC-01 | "Related files" panel for a selected file (vector neighbours at document level, excluding duplicates). | S |
| FR-DISC-02 | Near-duplicate and version clusters with diff-style comparison of extracted text. | S |
| FR-DISC-03 | "Projects" — automatic grouping by folder + content similarity, user-renamable. | C |

### 4.5 Ask your files (FR-ASK) — Stage 6

| ID | Requirement | Pri |
|---|---|---|
| FR-ASK-01 | Ask a question across all indexed files or a selected set. | S |
| FR-ASK-02 | Every factual sentence in an answer cites ≥ 1 retrieved passage; citations open the source at the passage. | S |
| FR-ASK-03 | Answers label *direct evidence* vs *inference*, and surface conflicting/outdated sources. | S |
| FR-ASK-04 | When evidence is insufficient, Recall says so instead of answering. | S |
| FR-ASK-05 | Document contents are treated as untrusted data; instructions inside documents are never followed. | S (M for any LLM feature) |

### 4.6 Assisted actions (FR-ACT) — Stage 7

| ID | Requirement | Pri |
|---|---|---|
| FR-ACT-01 | Suggestions only: archive superseded drafts, review duplicates, rename, group into folders. | C |
| FR-ACT-02 | Each action shows an exact preview (from → to) and requires explicit approval; deletes go to the Recycle Bin only. | C |
| FR-ACT-03 | Every executed action is logged and undoable where the OS allows. | C |

### 4.7 Privacy & data control (FR-PRIV)

| ID | Requirement | Pri |
|---|---|---|
| FR-PRIV-01 | Settings page shows where index data lives and how large it is. | M |
| FR-PRIV-02 | "Delete all Recall data" wipes the database and caches (files on disk untouched). | M |
| FR-PRIV-03 | Logs never contain document text or search queries; file paths are redacted by default. | M |
| FR-PRIV-04 | No telemetry. | M |

## 5. Non-functional requirements

Numbers below are **targets to validate**, not measurements. Stage 0 measures the real values on the development machine and these targets are revised then (see [07 §6](07-testing-and-acceptance.md)).

| ID | Area | Target |
|---|---|---|
| NFR-01 | Offline | All MVP workflows pass the offline procedure ([07 §8](07-testing-and-acceptance.md)) with networking disabled. |
| NFR-02 | Network | Zero non-loopback connections from any Recall process during normal operation (verified by audit). |
| NFR-03 | Keyword search latency | p95 ≤ 300 ms at 50k chunks, warm, dev machine. |
| NFR-04 | Hybrid search latency | p95 ≤ 1.5 s at 50k chunks incl. query embedding, model warm, dev machine. |
| NFR-05 | First results | Results visible ≤ 2 s after the user stops typing (debounce included). |
| NFR-06 | Retrieval quality | On the eval set (file level): **MVP** hybrid Recall@10 ≥ 0.80, MRR@10 ≥ 0.55, hybrid not worse than either single mode; **Stage 4** Recall@10 ≥ 0.85, MRR@10 ≥ 0.60, hybrid ≥ best single mode + 0.03 (gates in [07 §5.4](07-testing-and-acceptance.md)). |
| NFR-07 | Indexing throughput | Measured in Stage 0; MVP target set then. Provisional: a 2,000-document mixed corpus fully indexed in ≤ 30 min on the dev machine. |
| NFR-08 | UI responsiveness | UI thread never blocked > 100 ms by indexing (indexing runs out of process). |
| NFR-09 | Memory | Recall processes (excluding Ollama) ≤ 600 MB RSS during indexing; ≤ 300 MB idle. |
| NFR-10 | Robustness | A malformed file never crashes the app; a crash mid-indexing never corrupts the database. |
| NFR-11 | Accessibility | WCAG 2.2 AA for all MVP screens; full keyboard operation. |
| NFR-12 | Data safety | Recall opens user files read-only until Stage 7; no write/delete code paths exist before then. |
| NFR-13 | Install | One installer; first useful search within 15 min on a fresh machine with Ollama already installed (excluding model download time). |

### 5.1 Hardware and OS targets

| | Minimum (provisional) | Recommended |
|---|---|---|
| OS | Windows 10 22H2 x64 or Windows 11 x64 | Windows 11 x64 |
| RAM | 8 GB (search + embeddings) | 16 GB+ (needed for Ask your files with a 3–4B model) |
| CPU | 4 cores, AVX2 | 8 cores |
| Disk | 2 GB free for models + index growth (≈ index size depends on corpus; measured in Stage 0) | SSD |
| GPU | Not required | Optional; Ollama uses it when supported |

Note: the machine this plan was written on is **Windows 10 Pro 19045, AMD Ryzen 7 5700G (integrated Radeon), 15.4 GB RAM** — *not* the Windows 11 / Core Ultra 5 / 30 GB machine described in the brief. Performance targets are validated on whichever machine is the actual dev machine; see [10 §2](10-risks-and-open-decisions.md).

## 6. Degraded modes (must be designed, not accidental)

| Condition | Behaviour |
|---|---|
| Ollama not installed | Onboarding shows setup steps; Recall still indexes text and offers **keyword-only search**. Banner: "Meaning-based search is off until local AI is set up." |
| Ollama installed, not running | Detect, offer "Start Ollama" (launches the installed app; never installs anything), keep polling. Keyword search works. |
| Embedding model missing | Offer download (explicit consent: uses internet once). Chunks queue as "awaiting embeddings". |
| Model download fails | Show reason, retry, resume (Ollama pull resumes partial layers); keyword search unaffected. |
| Insufficient RAM for chat model | Ask your files disabled with explanation; search unaffected. |
| Ollama crashes mid-indexing | Embedding jobs back off and resume; no data loss. |
| Database corruption detected | Offer rebuild from source files (index is fully regenerable). |

## 7. MVP scope (the smallest complete product)

The MVP ships at the end of **Stage 3** ([08](08-development-roadmap.md)). It is "complete" in the sense that a non-technical user can install it, add folders, search by meaning, trust the evidence, open files, and keep using it daily as files change — offline.

### In MVP

- Windows x64 installer (unsigned or signed — see decision D-07).
- Onboarding: privacy promise → local AI check → folder selection → indexing.
- Formats: **TXT, Markdown, PDF (text layer), DOCX**, and plain-text source/config files (`.js .ts .py .java .cs .go .rs .json .yaml .toml .csv .html .css .sql` and similar — see [04 §2](04-search-and-retrieval.md)).
- Hybrid search (RRF fusion of FTS5 BM25 + vector KNN), file-level results, evidence passages, highlighted terms, deterministic match reasons, low-confidence state, duplicate collapse.
- Open file / reveal in Explorer / copy path.
- Basic document detail view (extracted text with matches, metadata, index status).
- Folder management: add, remove (with data deletion), exclusions, rebuild, pause/resume, retry failures.
- Incremental indexing: watcher + startup reconciliation; content-hash dedupe; move/rename detection.
- Local AI readiness: detection, guided setup, model download with consent, keyword-only fallback.
- Settings: data location & size, delete all data, model status.
- Privacy-safe logs; no telemetry; loopback-only network.
- Offline validation passed and documented.

### Explicitly out of MVP

OCR (images, scanned PDFs) · filters UI · temporal ranking · version grouping · related files · Ask your files · assisted actions · PPTX/XLSX/EML · global hotkey · search history · auto-update · macOS/Linux · multi-language tuning beyond what the embedding model provides · cloud anything.

## 8. Success measures

| Measure | How measured |
|---|---|
| Retrieval quality meets NFR-06 | Automated eval harness on the curated corpus ([07 §5](07-testing-and-acceptance.md)) |
| Users find a target file in ≤ 2 queries in ≥ 80% of scripted tasks | Moderated usability session (5 participants, scripted tasks) after Stage 3 |
| Zero non-loopback traffic | Network audit ([06 §8](06-security-and-privacy.md)) |
| No data loss / corruption in crash tests | Kill-during-indexing tests ([07 §4.4](07-testing-and-acceptance.md)) |

## 9. Assumptions

| ID | Assumption | Validated in |
|---|---|---|
| A-01 | Users accept installing Ollama separately (Recall does not bundle it in MVP). | D-01, usability test |
| A-02 | Typical personal corpus in scope: 1k–20k files, ≤ 200k chunks. Larger corpora are supported but not performance-targeted in MVP. | Stage 0 benchmark |
| A-03 | English is the primary content language for evaluation; multilingual quality depends on the chosen embedding model. | Stage 0 model eval |
| A-04 | Most target PDFs have a text layer; scanned PDFs are handled by optional OCR later. | Corpus survey with the team |
| A-05 | The team can supply a realistic (non-confidential or synthetic) evaluation corpus. | D-09 |
