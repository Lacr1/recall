# ADR-0001: Electron desktop runtime

**Status:** Accepted (2026-10-09)

**Context.** Recall needs native folder dialogs, safe file opening, background indexing and a mature Windows installer. It also needs the Node ecosystem for SQLite, PDF/DOCX parsing and file watching.

**Decision.** Electron, pinned to an exact version (44.7.0 at the time of writing). Upgrade one major version at a time at stage boundaries, staying within the three supported majors.

**Alternatives.**
- Tauri: Rust backend, so the Node parsers can't be used directly.
- .NET/WinUI: a different language from every candidate library.
- Local web server + browser: no native integration, and the localhost server is an attack surface.

**Consequences.** A ~138 MB installer, Chromium's memory overhead, and an 8-week Electron release cadence to keep up with.

**Evidence.** The dev build, the dev server and the packaged `Recall.exe` all pass the smoke test ([hackathon-build.md](../validation/hackathon-build.md)).
