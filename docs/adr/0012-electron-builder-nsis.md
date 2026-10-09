# ADR-0012: electron-builder NSIS per-user installer

**Status:** Accepted (2026-10-09)

**Decision.**
- electron-builder 26 producing an NSIS installer for 64-bit Windows.
- Installs per user, with no admin rights, and the install folder can be changed.
- App data is kept on uninstall for now; decision D-11 is still open.
- `asarUnpack` covers `*.node`, better-sqlite3 and pdfjs-dist (which is loaded by dynamic import).
- Builds are unsigned for now (D-07).

**Evidence.** `dist/Recall-Setup-0.1.0.exe` (138 MB) builds, and the unpacked app passes the smoke test.

**Open.** Electron fuses aren't set yet (SEC-09, S2-12), and the installer hasn't been tested on a clean machine (S3-10).
