# ADR-0003: Engine in a utilityProcess; the main process only brokers calls

**Status:** Accepted (2026-10-09)

**Context.** Indexing work (PDF parsing, hashing, synchronous SQLite calls) would block the main process's event loop and freeze the window. A crash in a parser must not take the UI down with it.

**Decision.**
- The engine runs in an Electron `utilityProcess`. It owns the database, scanner, pipeline, search, the Ollama client and Ask.
- `EngineSupervisor` starts the engine and restarts it after a crash, with backoff. It stops retrying after more than 3 crashes in 5 minutes.
- The main process keeps only windows, dialogs, `shell` calls and IPC validation. It forwards RPC calls to the engine over the utility process's message port.

**Alternatives.**
- Engine in the main process.
- A hidden BrowserWindow.
- `child_process.fork`, which breaks once the `runAsNode` fuse is disabled.

**Consequences.** Each call makes two hops (renderer → main → engine). Measured search round trips still take only tens of milliseconds.

**Evidence.** better-sqlite3 and pdf.js load and run inside the utilityProcess, in both dev and packaged builds (smoke test exits with code 0).
