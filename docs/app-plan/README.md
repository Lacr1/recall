# Recall — Application Plan

> **"Your computer should remember what you forgot."**
> A local-first desktop app that finds, explains, and (later) acts on information in the user's own files — with no cloud services.
>
> Status: **Planning complete — awaiting human approval.** No application code has been written. Plan date: 2026-10-09.

## 1. Project state at planning time

The repository was **empty** (no code, documents, dependencies, or experiments) and not under version control. There is **no existing proof of concept** in this repository, so nothing has been demonstrated or tested. The dev environment has Node 24.21, npm 11, git, and Ollama 0.40.2 running with only `qwen2.5:3b` pulled (`nomic-embed-text` is not present). The inspected machine (Windows 10, Ryzen 7 5700G, 15.4 GB RAM) differs from the machine described in the brief — see [D-02](10-risks-and-open-decisions.md).

## 2. Reading order

| # | Document | Read if you want… | Audience |
|---|---|---|---|
| 1 | [01 — Product specification](01-product-specification.md) | Vision, personas, requirements, **MVP scope** | Everyone |
| 2 | [02 — UX and user flows](02-ux-and-user-flows.md) | Screens, wireframes, flows, accessibility | Product, design, dev |
| 3 | [03 — System architecture](03-system-architecture.md) | Technology choices, processes, modules, IPC, ADRs | Dev |
| 4 | [04 — Search and retrieval](04-search-and-retrieval.md) | Ingestion, chunking, embeddings, hybrid ranking, evidence, Ask | Dev |
| 5 | [05 — Data model and indexing](05-data-model-and-indexing.md) | Schema, ER diagram, change detection, deletion, migrations | Dev |
| 6 | [06 — Security and privacy](06-security-and-privacy.md) | Threat model, Electron hardening, network policy, LLM safety | Everyone |
| 7 | [07 — Testing and acceptance](07-testing-and-acceptance.md) | Test layers, eval metrics, offline procedure | Dev, QA |
| 8 | [08 — Development roadmap](08-development-roadmap.md) | Stages, acceptance, estimates, demo cut | Everyone |
| 9 | [09 — Team and workflow](09-team-and-workflow.md) | Milestone loop, conventions, review checklist | Dev, reviewers |
| 10 | [10 — Risks and open decisions](10-risks-and-open-decisions.md) | **Decisions needing approval**, risks, assumptions | Approvers |
| 11 | [11 — Implementation backlog](11-implementation-backlog.md) | Ordered tasks for implementation sessions | Dev |
| 12 | [12 — Voice assistant](12-voice-assistant.md) | Stage 8: "Recall" wake word, popup answers and copied paths, tray, onboarding step | Everyone |

Approvers in a hurry: read §3 below, then [10 §1](10-risks-and-open-decisions.md) and [01 §7](01-product-specification.md).

## 3. Critical decisions (summary)

| Area | Decision | Where |
|---|---|---|
| Runtime | Electron (latest stable; 44.x at planning time), React + Vite + TypeScript via electron-vite; no Next.js | [03 §3](03-system-architecture.md) |
| Processes | Thin main process; **engine in an Electron `utilityProcess`** owns DB, indexing, search, AI client; extraction in worker threads with timeouts/heap caps | [03 §4](03-system-architecture.md) |
| Storage | **SQLite (better-sqlite3 13) as the single source of truth**; FTS5 for keywords; vectors in the same DB with sqlite-vec exact search (vec0 as upgrade path) | [03](03-system-architecture.md), [05](05-data-model-and-indexing.md) |
| Data model | **Content-addressed**: files → contents (SHA-256) → chunks → vectors. Renames/moves/duplicates never re-embed. DB status columns are the work queue. | [05](05-data-model-and-indexing.md) |
| Local AI | Ollama on loopback only; `nomic-embed-text` default embedding model (bake-off in Stage 0); chat model for Stage 6 chosen from Apache-2.0/MIT candidates (`qwen2.5:3b` is research-licensed) | [04 §5](04-search-and-retrieval.md), [D-04](10-risks-and-open-decisions.md) |
| Retrieval | Two-phase indexing (keyword-searchable first); hybrid = **RRF** over BM25 chunks + vectors + file names; file-level results with evidence passages, highlights, deterministic match reasons; calibrated low-confidence rule | [04](04-search-and-retrieval.md) |
| Degraded mode | No Ollama / no model ⇒ keyword-only search, clearly labelled | [01 §6](01-product-specification.md) |
| Security | Sandboxed renderer, typed + validated IPC, IDs not paths, open-file guard, loopback-only network guard + firewall audit, privacy-safe logs, data in LocalAppData | [06](06-security-and-privacy.md) |
| Quality | Most tests need no model (fake/recorded embeddings, fake Ollama server); eval harness compares keyword/semantic/hybrid; offline procedure gates the "works offline" claim | [07](07-testing-and-acceptance.md) |
| Delivery | Stages 0–3 = MVP (≈ 33–46 focused days); one bounded backlog item per session with evidence-based reports | [08](08-development-roadmap.md), [09](09-team-and-workflow.md) |

## 4. MVP in one paragraph

A Windows installer for a per-user app that onboards the user (privacy promise → local AI check with consented model download → folder selection), indexes TXT, Markdown, PDF (text layer), DOCX and source/text files in the background, and offers a single search box with hybrid ranking. Results show evidence passages, highlights, match reasons, and duplicate copies, and open the original file safely. Folder management, failure reporting, and data deletion are included. The index stays correct as files change, survives crashes, falls back to keyword search without Ollama, and passes a documented offline procedure. OCR, filters, versions, related files, Ask your files, and file actions come after the MVP.

## 5. Conventions in these documents

- **Verified facts** cite a source link and were checked on 2026-10-09. **Targets** and **starting values** are labelled as such and are validated in Stage 0/1. **Unverified** items are listed in [10 §4](10-risks-and-open-decisions.md).
- IDs: `FR-*`/`NFR-*` requirements ([01](01-product-specification.md)), `SEC-*` security requirements ([06 §11](06-security-and-privacy.md)), `ADR-*` ([03 §9](03-system-architecture.md)), `D-*` decisions and `R-*` risks ([10](10-risks-and-open-decisions.md)), `S<stage>-<n>` backlog items ([11](11-implementation-backlog.md)).

## 6. Changelog

| Date | Change |
|---|---|
| 2026-10-09 | Initial plan (12 documents). |
| 2026-10-09 | Decisions: D-02 = this PC is the benchmark machine; D-03 = pull `nomic-embed-text` only; D-09 = synthetic corpus only; D-13 = deadline **2026-10-10**. With a one-day deadline, a hackathon cut was built instead of following Stage 0 → 3. What it includes, how it differs from the plan, and the evidence are in [docs/validation/hackathon-build.md](../validation/hackathon-build.md). The plan stays the reference for continuing toward the MVP. |
| 2026-10-09 | Added [12 — Voice assistant](12-voice-assistant.md) (Stage 8, draft for approval): decisions D-16…D-24, risks R-17…R-24, backlog S8-01…S8-12. |
| 2026-10-09 | Plan 12 approved. S8-01 done: sherpa-onnx confirmed (ADR-0015), Moonshine tiny for speech-to-text, new decision D-25 (LibriSpeech wake-word model), NFR-V-03/05 revised. See [s8-01-voice-spike.md](../validation/s8-01-voice-spike.md). |
