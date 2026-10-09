# ADR-0011: Extraction isolated in worker threads

**Status:** Proposed. Not built yet.

**Context.** A malformed or hostile PDF or DOCX file can hang a parser or exhaust memory.

**Current state (hackathon build).**
- Extraction runs on the engine's event loop with a 60-second timeout.
- It has size caps (50 MB per file, 200 MB for PDFs) and a 2-million-character cap on extracted text.
- A timeout releases the caller, but a parser stuck in CPU-bound work would still block the engine.
- If a parser crashes, the engine process dies and the supervisor restarts it, so the UI stays up.

**Decision (planned).** A `worker_threads` pool with:
- a per-file timeout enforced by `worker.terminate()`;
- heap caps via `resourceLimits`;
- workers recycled after a set number of files.

**Trigger.** Required before the MVP (SEC-05).
