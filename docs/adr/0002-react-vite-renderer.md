# ADR-0002: React + Vite via electron-vite, no Next.js

**Status:** Accepted (2026-10-09)

**Context.** The renderer loads static local files, with no server and no network access. What Next.js adds (server-side rendering, server components, API routes) doesn't apply here.

**Decision.**
- React 19, Vite 7.3 and TypeScript.
- Built with electron-vite 5.0, which produces the main, preload and renderer builds; the engine is a second main-process entry.
- Plain CSS with design tokens. Tailwind and Radix are deferred.

**Alternatives.**
- Next.js static export.
- Forge's Vite plugin, which Forge's own docs mark as experimental.

**Consequences.** electron-vite 5.0 declares peer support for Vite 5 to 7 only. That pins Vite to 7.x and `@vitejs/plugin-react` to 5.x until electron-vite supports Vite 8.

**Evidence.** `npm run dev` loads under the CSP with hot reload, and the production build passes the smoke test.
