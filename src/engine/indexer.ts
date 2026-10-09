import { createHash } from 'node:crypto'
import { createReadStream, watch, type FSWatcher } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DB } from './db'
import { getSetting, setSetting } from './db'
import { chunkDocument, embeddingText } from './chunk'
import { ExtractError, extractFile } from './extract'
import { embed, OllamaError } from './ollama'
import {
  isBlockedFolder, isExcludedDir, isExcludedFile, isInsideRoot, kindForExt, pathKey, sizeCapFor, tokenizeName, tokenizePath,
  type Kind
} from './paths'
import { activateBuilding, activeSpace, buildingSpace, noteSpaceFacts, type EmbeddingSpace } from './spaces'
import { toUnitVec, vecToBuffer, type VectorIndex } from './vectors'
import { storeSignature } from './versions'
import type { FailureItem, FolderInfo, IndexProgress } from '../shared/types'

const ORPHAN_GRACE_MS = 10 * 60_000
const EMBED_BATCH = 16
const RECONCILE_EVERY_MS = 10 * 60_000

export class UserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

type ChunkRow = { id: number; content_id: number; text: string; section_path: string | null; title: string | null }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const yieldLoop = () => new Promise((r) => setImmediate(r))

export class Indexer {
  private paused: boolean
  private scanQueue = new Set<number>()
  private scanning = false
  private watchers = new Map<number, FSWatcher>()
  private debounce = new Map<number, NodeJS.Timeout>()
  private wakers: (() => void)[] = []
  private stopped = false
  private aiReady = false
  private embedBlockedUntil = 0
  /** Contents the model being built could not embed; they end up 'failed' after the swap. */
  private buildFailed = { spaceId: 0, contents: new Set<number>() }
  /** Called after a model change completes and the new space serves search. */
  onSpaceActivated: () => void = () => undefined
  /** S4-06: images and scanned PDFs are read with OCR. Off by default. */
  private ocr: boolean

  constructor(
    private readonly db: DB,
    private readonly vectors: VectorIndex,
    private readonly onChange: () => void,
    private readonly onAiFailure: (err: OllamaError) => void,
    /** Lane errors other than expected ones; the engine uses it to stop on database damage. */
    private readonly onLaneError: (err: unknown) => void = () => undefined
  ) {
    this.paused = getSetting(db, 'paused') === '1'
    this.ocr = getSetting(db, 'ocr') === '1'
  }

  get ocrEnabled(): boolean {
    return this.ocr
  }

  /**
   * Turning OCR on reads scanned PDFs again and picks up images on a rescan; turning it off drops images from
   * the index on that rescan and stops the OCR worker. Text already read from scanned PDFs is kept.
   */
  setOcr(on: boolean): void {
    if (on === this.ocr) return
    this.ocr = on
    setSetting(this.db, 'ocr', on ? '1' : '0')
    if (on) {
      this.db.prepare("UPDATE contents SET extract_status = 'pending', extract_attempts = 0 WHERE kind = 'pdf' AND extract_status = 'no_text'").run()
    } else {
      void import('./ocr').then((m) => m.stopOcr())
    }
    for (const f of this.folderRows()) this.scanQueue.add(f.id)
    this.wake()
    this.onChange()
  }

  start(): void {
    for (const f of this.folderRows()) {
      this.scanQueue.add(f.id)
      this.watchFolder(f.id, f.path)
    }
    void this.scanLoop()
    void this.hashLoop()
    void this.extractLoop()
    void this.embedLoop()
    void this.buildLoop()
    setInterval(() => {
      for (const f of this.folderRows()) this.scanQueue.add(f.id)
      this.gc(false)
      this.wake()
    }, RECONCILE_EVERY_MS).unref()
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers.values()) w.close()
    this.wake()
  }

  /** Lets idle lanes look for work now, e.g. after a model change started. */
  wakeLanes(): void {
    this.wake()
  }

  setAiReady(ready: boolean): void {
    this.aiReady = ready
    if (ready) this.embedBlockedUntil = 0
    this.wake()
  }

  setPaused(paused: boolean): void {
    this.paused = paused
    setSetting(this.db, 'paused', paused ? '1' : '0')
    this.wake()
    this.onChange()
  }

  // ---------- folders ----------

  addFolder(folderPath: string): FolderInfo {
    const blocked = isBlockedFolder(folderPath)
    if (blocked) throw new UserError('FOLDER_BLOCKED', blocked)
    const key = pathKey(folderPath)
    for (const f of this.folderRows()) {
      if (f.path_key === key) throw new UserError('FOLDER_EXISTS', 'This folder is already in Recall.')
      if (isInsideRoot(folderPath, f.path)) throw new UserError('FOLDER_INSIDE', `Already included in ${f.path}.`)
    }
    // Adding a parent of existing folders replaces them; their content is re-linked by hash.
    for (const f of this.folderRows()) if (isInsideRoot(f.path, folderPath)) this.removeFolder(f.id)
    const id = Number(
      this.db.prepare('INSERT INTO folders(path, path_key, added_at) VALUES (?, ?, ?)').run(path.resolve(folderPath), key, Date.now())
        .lastInsertRowid
    )
    this.scanQueue.add(id)
    this.watchFolder(id, path.resolve(folderPath))
    this.wake()
    this.onChange()
    return this.listFolders().find((f) => f.id === id)!
  }

  removeFolder(folderId: number): void {
    this.watchers.get(folderId)?.close()
    this.watchers.delete(folderId)
    this.scanQueue.delete(folderId)
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId)
    this.gc(true) // the user asked Recall to forget: no grace period
    this.db.pragma('wal_checkpoint(TRUNCATE)')
    this.onChange()
  }

  rescanFolder(folderId: number): void {
    this.scanQueue.add(folderId)
    this.wake()
  }

  retryFailed(): number {
    const a = this.db.prepare("UPDATE files SET status = 'pending', attempts = 0, error_code = NULL WHERE status = 'error'").run().changes
    const b = this.db
      .prepare("UPDATE contents SET extract_status = 'pending', extract_attempts = 0 WHERE extract_status IN ('timeout','failed')")
      .run().changes
    const c = this.db.prepare("UPDATE contents SET embed_status = 'pending' WHERE embed_status = 'failed'").run().changes
    this.buildFailed.contents.clear()
    this.wake()
    this.onChange()
    return a + b + c
  }

  listFolders(): FolderInfo[] {
    return this.db
      .prepare(
        `SELECT f.id, f.path, f.status,
          (SELECT count(*) FROM files x WHERE x.folder_id = f.id AND x.status IN ('linked','pending')) fileCount,
          (SELECT count(*) FROM files x WHERE x.folder_id = f.id AND x.status = 'skipped') skippedCount,
          (SELECT count(*) FROM files x LEFT JOIN contents c ON c.id = x.content_id
             WHERE x.folder_id = f.id AND (x.status = 'error' OR c.extract_status NOT IN ('ok','pending'))) failedCount
         FROM folders f ORDER BY f.path`
      )
      .all() as FolderInfo[]
  }

  listFailures(): FailureItem[] {
    const rows = this.db
      .prepare(
        `SELECT x.id fileId, x.name, f.path || '\\' || x.rel_path path, x.status, x.skip_reason, x.error_code,
                c.extract_status, c.embed_status
         FROM files x JOIN folders f ON f.id = x.folder_id LEFT JOIN contents c ON c.id = x.content_id
         WHERE x.status IN ('skipped','error') OR c.extract_status NOT IN ('ok','pending') OR c.embed_status = 'failed'
         ORDER BY x.name LIMIT 500`
      )
      .all() as {
      fileId: number; name: string; path: string; status: string; skip_reason: string | null; error_code: string | null
      extract_status: string | null; embed_status: string | null
    }[]
    return rows.map((r) => ({ fileId: r.fileId, name: r.name, path: r.path, reason: describeFailure(r) }))
  }

  progress(): IndexProgress {
    const one = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n
    return {
      paused: this.paused,
      scanning: this.scanning || this.scanQueue.size > 0,
      filesTotal: one("SELECT count(*) n FROM files WHERE status IN ('linked','pending')"),
      filesPending: one("SELECT count(*) n FROM files WHERE status = 'pending'"),
      readTotal: one('SELECT count(*) n FROM contents WHERE EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)'),
      readDone: one(
        "SELECT count(*) n FROM contents WHERE extract_status <> 'pending' AND EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)"
      ),
      embedTotal: one(
        "SELECT count(*) n FROM contents WHERE extract_status = 'ok' AND chunk_count > 0 AND EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)"
      ),
      // Failed contents are finished too (they are listed as failures), or progress would never complete.
      embedDone: one(
        "SELECT count(*) n FROM contents WHERE extract_status = 'ok' AND embed_status IN ('done','failed') AND EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)"
      ),
      skipped: one("SELECT count(*) n FROM files WHERE status = 'skipped'"),
      failed: one(
        "SELECT count(*) n FROM files x LEFT JOIN contents c ON c.id = x.content_id WHERE x.status = 'error' OR c.extract_status NOT IN ('ok','pending')"
      ),
      chunks: one("SELECT count(*) n FROM chunk_vectors WHERE space_id = (SELECT id FROM embedding_spaces WHERE status = 'active')")
    }
  }

  private folderRows(): { id: number; path: string; path_key: string }[] {
    return this.db.prepare('SELECT id, path, path_key FROM folders').all() as { id: number; path: string; path_key: string }[]
  }

  private watchFolder(folderId: number, root: string): void {
    try {
      const w = watch(root, { recursive: true }, () => {
        clearTimeout(this.debounce.get(folderId))
        this.debounce.set(
          folderId,
          setTimeout(() => {
            this.scanQueue.add(folderId)
            this.wake()
          }, 1500)
        )
      })
      w.on('error', () => this.watchers.delete(folderId)) // periodic reconcile still covers this folder
      this.watchers.set(folderId, w)
    } catch {
      // Root unavailable; reconcile marks it and retries later.
    }
  }

  // ---------- lanes ----------

  private wake(): void {
    const w = this.wakers
    this.wakers = []
    for (const fn of w) fn()
  }

  private idle(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms)
      const self = this
      function done() {
        clearTimeout(t)
        self.wakers = self.wakers.filter((x) => x !== done)
        resolve()
      }
      this.wakers.push(done)
    })
  }

  private async lane(name: string, step: () => Promise<boolean>): Promise<void> {
    while (!this.stopped) {
      if (this.paused) {
        await this.idle(5000)
        continue
      }
      let didWork = false
      try {
        didWork = await step()
      } catch (err) {
        console.error(`[engine] ${name} lane error:`, (err as Error).name, (err as { code?: string }).code ?? '')
        this.onLaneError(err)
        await sleep(1000)
      }
      if (didWork) {
        this.onChange()
        this.wake() // work here usually creates work for the next lane
        await yieldLoop()
      } else await this.idle(10_000)
    }
  }

  private scanLoop = () =>
    this.lane('scan', async () => {
      const next = this.scanQueue.values().next()
      if (next.done) return false
      this.scanQueue.delete(next.value)
      this.scanning = true
      try {
        await this.reconcile(next.value)
      } finally {
        this.scanning = false
      }
      this.gc(false)
      return true
    })

  private hashLoop = () =>
    this.lane('hash', async () => {
      const rows = this.db
        .prepare(
          `SELECT x.id, x.ext, x.content_id, f.path || '\\' || x.rel_path abs FROM files x JOIN folders f ON f.id = x.folder_id
           WHERE x.status = 'pending' ORDER BY x.mtime_ms DESC LIMIT 25`
        )
        .all() as { id: number; ext: string; content_id: number | null; abs: string }[]
      for (const r of rows) await this.hashFile(r)
      return rows.length > 0
    })

  // Extract and embed take documents and notes before code, so what people search for most is ready first.
  private extractLoop = () =>
    this.lane('extract', async () => {
      const row = this.db
        .prepare(
          `SELECT c.id, c.kind, c.extract_attempts, f.path || '\\' || x.rel_path abs
           FROM contents c JOIN files x ON x.content_id = c.id JOIN folders f ON f.id = x.folder_id
           WHERE c.extract_status = 'pending' ORDER BY c.kind = 'code', x.mtime_ms DESC LIMIT 1`
        )
        .get() as { id: number; kind: Kind; extract_attempts: number; abs: string } | undefined
      if (!row) return this.backfillSignatures()
      await this.extractContent(row)
      return true
    })

  /** Version signatures for contents read before they existed (index format v3), from their stored chunks. */
  private backfillSignatures(): boolean {
    const ids = this.db
      .prepare(
        `SELECT c.id FROM contents c WHERE c.extract_status = 'ok' AND c.chunk_count > 0
         AND NOT EXISTS (SELECT 1 FROM content_signatures s WHERE s.content_id = c.id) LIMIT 20`
      )
      .all() as { id: number }[]
    const chunksOf = this.db.prepare('SELECT text, char_start, char_end FROM chunks WHERE content_id = ? ORDER BY ord')
    for (const { id } of ids) {
      // Chunks overlap; keep only the new part of each so the text matches what extraction saw.
      let text = ''
      let cursor = 0
      for (const c of chunksOf.all(id) as { text: string; char_start: number; char_end: number }[]) {
        if (c.char_end <= cursor) continue
        text += (c.char_start > cursor ? '\n' : '') + c.text.slice(Math.max(cursor, c.char_start) - c.char_start)
        cursor = c.char_end
      }
      storeSignature(this.db, id, text)
    }
    return ids.length > 0
  }

  private embedLoop = () =>
    this.lane('embed', async () => {
      if (!this.aiReady || Date.now() < this.embedBlockedUntil) return false
      const space = activeSpace(this.db)
      const rows = this.db
        .prepare(
          `SELECT ch.id, ch.content_id, ch.text, ch.section_path, c.title FROM chunks ch JOIN contents c ON c.id = ch.content_id
           LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id AND v.space_id = ?
           WHERE c.extract_status = 'ok' AND c.embed_status = 'pending' AND v.chunk_id IS NULL
             AND EXISTS (SELECT 1 FROM files WHERE content_id = c.id)
           ORDER BY c.kind = 'code', c.id LIMIT ?`
        )
        .all(space.id, EMBED_BATCH) as ChunkRow[]
      if (!rows.length) {
        // Contents whose chunks are all embedded (or that have none) are done.
        const n = this.db
          .prepare(
            `UPDATE contents SET embed_status = 'done' WHERE extract_status = 'ok' AND embed_status = 'pending'
             AND NOT EXISTS (SELECT 1 FROM chunks ch LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id AND v.space_id = ?
                             WHERE ch.content_id = contents.id AND v.chunk_id IS NULL)`
          )
          .run(space.id).changes
        return n > 0
      }
      await this.embedChunks(rows, space, false)
      return true
    })

  /**
   * S4-07: fills a space being built for a new model, alongside the active one, then swaps it in. Search keeps
   * using the active space until the swap; new files are embedded in both meanwhile.
   */
  private buildLoop = () =>
    this.lane('rebuild', async () => {
      if (!this.aiReady || Date.now() < this.embedBlockedUntil) return false
      const space = buildingSpace(this.db)
      if (!space) return false
      if (space.id !== this.buildFailed.spaceId) this.buildFailed = { spaceId: space.id, contents: new Set() }
      const rows = this.db
        .prepare(
          `SELECT ch.id, ch.content_id, ch.text, ch.section_path, c.title FROM chunks ch JOIN contents c ON c.id = ch.content_id
           LEFT JOIN chunk_vectors v ON v.chunk_id = ch.id AND v.space_id = ?
           WHERE c.extract_status = 'ok' AND v.chunk_id IS NULL AND EXISTS (SELECT 1 FROM files WHERE content_id = c.id)
             AND c.id NOT IN (SELECT value FROM json_each(?))
           ORDER BY c.kind = 'code', c.id LIMIT ?`
        )
        .all(space.id, JSON.stringify([...this.buildFailed.contents]), EMBED_BATCH) as ChunkRow[]
      if (rows.length) {
        await this.embedChunks(rows, space, true)
        return true
      }
      activateBuilding(this.db, this.buildFailed.contents)
      this.vectors.invalidate()
      this.onSpaceActivated()
      return true
    })

  /** Progress of a model change: chunks with a vector in the space being built, of all chunks to embed. */
  buildProgress(): { model: string; done: number; total: number } | undefined {
    const space = buildingSpace(this.db)
    if (!space) return undefined
    const one = (sql: string, ...p: unknown[]) => (this.db.prepare(sql).get(...p) as { n: number }).n
    const live = "c.extract_status = 'ok' AND EXISTS (SELECT 1 FROM files WHERE content_id = c.id)"
    return {
      model: space.model,
      total: one(`SELECT count(*) n FROM chunks ch JOIN contents c ON c.id = ch.content_id WHERE ${live}`),
      done: one(`SELECT count(*) n FROM chunk_vectors v JOIN chunks ch ON ch.id = v.chunk_id JOIN contents c ON c.id = ch.content_id WHERE v.space_id = ? AND ${live}`, space.id)
    }
  }

  // ---------- reconcile ----------

  private async reconcile(folderId: number): Promise<void> {
    const folder = this.db.prepare('SELECT id, path, scan_generation FROM folders WHERE id = ?').get(folderId) as
      | { id: number; path: string; scan_generation: number }
      | undefined
    if (!folder) return
    try {
      const s = await stat(folder.path)
      if (!s.isDirectory()) throw new Error('not a directory')
    } catch {
      // Never treat a missing root as "all files deleted".
      this.db.prepare("UPDATE folders SET status = 'unavailable' WHERE id = ?").run(folderId)
      return
    }
    const gen = folder.scan_generation + 1
    this.db.prepare("UPDATE folders SET status = 'active', scan_generation = ? WHERE id = ?").run(gen, folderId)

    const getFile = this.db.prepare('SELECT id, size, mtime_ms, status FROM files WHERE path_key = ?')
    const touch = this.db.prepare('UPDATE files SET seen_generation = ? WHERE id = ?')
    // A skipped file drops its content link so GC removes the old chunks and vectors.
    const markChanged = this.db.prepare(
      `UPDATE files SET size = ?, mtime_ms = ?, status = ?, skip_reason = ?, attempts = 0, error_code = NULL, seen_generation = ?,
       content_id = CASE WHEN ? = 'skipped' THEN NULL ELSE content_id END WHERE id = ?`
    )
    const insert = this.db.prepare(
      `INSERT INTO files(folder_id, rel_path, path_key, name, ext, name_tokens, path_tokens, size, mtime_ms, status, skip_reason, seen_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )

    let batch: (() => void)[] = []
    const commit = () => {
      const ops = batch
      batch = []
      this.db.transaction(() => ops.forEach((op) => op()))()
    }

    const walk = async (dir: string): Promise<void> => {
      let handle
      try {
        handle = await opendir(dir)
      } catch {
        return // unreadable subfolder: skip
      }
      for await (const entry of handle) {
        if (this.stopped) return
        const abs = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!isExcludedDir(entry.name)) await walk(abs)
          continue
        }
        if (!entry.isFile() || isExcludedFile(entry.name)) continue // symlinks/junctions are not followed
        const ext = path.extname(entry.name).slice(1).toLowerCase()
        const kind = kindForExt(ext, { ocr: this.ocr })
        if (!kind) continue
        let s
        try {
          s = await stat(abs)
        } catch {
          continue
        }
        const tooLarge = s.size > sizeCapFor(kind, ext)
        const status = tooLarge ? 'skipped' : 'pending'
        const skip = tooLarge ? 'too_large' : null
        const key = pathKey(abs)
        const mtime = Math.floor(s.mtimeMs)
        batch.push(() => {
          const existing = getFile.get(key) as { id: number; size: number; mtime_ms: number; status: string } | undefined
          if (!existing) {
            const rel = path.relative(folder.path, abs)
            insert.run(folderId, rel, key, entry.name, ext, tokenizeName(entry.name), tokenizePath(rel), s.size, mtime, status, skip, gen)
          } else if (existing.size !== s.size || existing.mtime_ms !== mtime || tooLarge !== (existing.status === 'skipped')) {
            // The last condition applies a changed size cap to files indexed under the old one.
            markChanged.run(s.size, mtime, status, skip, gen, status, existing.id)
          } else {
            touch.run(gen, existing.id)
          }
        })
        if (batch.length >= 500) {
          commit()
          await yieldLoop()
        }
      }
    }

    await walk(folder.path)
    if (this.stopped) return
    commit()
    // Only a completed scan may delete rows for files that were not seen.
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM files WHERE folder_id = ? AND seen_generation < ?').run(folderId, gen)
      this.db.prepare('UPDATE folders SET last_scan_completed_at = ? WHERE id = ?').run(Date.now(), folderId)
    })()
    this.wake()
  }

  // ---------- hash ----------

  private async hashFile(r: { id: number; ext: string; content_id: number | null; abs: string }): Promise<void> {
    const kind = kindForExt(r.ext, { ocr: true })!
    let sha: string
    let size: number
    try {
      size = (await stat(r.abs)).size
      sha = await sha256File(r.abs)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        this.db.prepare('DELETE FROM files WHERE id = ?').run(r.id)
      } else {
        const label = code === 'EBUSY' || code === 'EPERM' ? 'locked' : code === 'EACCES' ? 'access_denied' : 'io_error'
        this.db
          .prepare("UPDATE files SET attempts = attempts + 1, error_code = ?, status = CASE WHEN attempts >= 4 THEN 'error' ELSE 'pending' END WHERE id = ?")
          .run(label, r.id)
        if (label === 'locked') await sleep(500)
      }
      return
    }
    this.db.transaction(() => {
      let content = this.db.prepare('SELECT id FROM contents WHERE sha256 = ? AND kind = ?').get(sha, kind) as { id: number } | undefined
      if (!content) {
        content = {
          id: Number(
            this.db.prepare('INSERT INTO contents(sha256, kind, size, created_at) VALUES (?, ?, ?, ?)').run(sha, kind, size, Date.now())
              .lastInsertRowid
          )
        }
      } else {
        this.db.prepare('UPDATE contents SET orphaned_at = NULL WHERE id = ?').run(content.id)
      }
      this.db.prepare("UPDATE files SET content_id = ?, status = 'linked', attempts = 0, error_code = NULL WHERE id = ?").run(content.id, r.id)
    })()
  }

  // ---------- extract ----------

  private async extractContent(row: { id: number; kind: Kind; extract_attempts: number; abs: string }): Promise<void> {
    try {
      const doc = await extractFile(row.abs, row.kind, { ocr: this.ocr })
      const chunks = chunkDocument(doc, row.kind)
      const insert = this.db.prepare(
        `INSERT INTO chunks(content_id, ord, text, char_start, char_end, page_start, page_end, section_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      let replaced = 0
      this.db.transaction(() => {
        replaced = this.db.prepare('DELETE FROM chunks WHERE content_id = ?').run(row.id).changes
        chunks.forEach((c, i) =>
          insert.run(row.id, i, c.text, c.start, c.end, c.pageStart ?? null, c.pageEnd ?? null, c.section ?? null)
        )
        this.db
          .prepare(
            `UPDATE contents SET extract_status = 'ok', extract_error = NULL, title = ?, page_count = ?, char_count = ?, chunk_count = ?,
             embed_status = CASE WHEN ? > 0 THEN 'pending' ELSE 'not_applicable' END WHERE id = ?`
          )
          .run(doc.title ?? null, doc.pageCount ?? null, doc.text.length, chunks.length, chunks.length, row.id)
      })()
      // New contents have no vectors yet; only re-extracted ones need their old vectors dropped.
      if (replaced > 0) this.vectors.removeContents(new Set([row.id]))
      if (chunks.length) storeSignature(this.db, row.id, doc.text)
    } catch (err) {
      if (err instanceof ExtractError && err.code !== 'timeout' && err.code !== 'failed') {
        this.db.prepare("UPDATE contents SET extract_status = ?, embed_status = 'not_applicable' WHERE id = ?").run(err.code, row.id)
      } else {
        const code = err instanceof ExtractError ? err.code : 'failed'
        const attempts = row.extract_attempts + 1
        this.db
          .prepare("UPDATE contents SET extract_attempts = ?, extract_status = ?, embed_status = 'not_applicable' WHERE id = ?")
          .run(attempts, attempts >= 3 ? code : 'pending', row.id)
      }
    }
  }

  // ---------- embed ----------

  private async embedChunks(rows: ChunkRow[], space: EmbeddingSpace, building: boolean): Promise<void> {
    const inputs = rows.map((r) => embeddingText(space.docPrefix, { text: r.text, section: r.section_path }, r.title))
    let vectors: number[][]
    try {
      vectors = await embed(space.model, inputs)
      if (space.dims && vectors.some((v) => v.length !== space.dims)) throw new OllamaError('bad_response', 'Embedding size changed')
    } catch (err) {
      if (err instanceof OllamaError && err.code === 'context_exceeded' && rows.length > 1) {
        // Isolate the offending chunk.
        const mid = Math.ceil(rows.length / 2)
        await this.embedChunks(rows.slice(0, mid), space, building)
        await this.embedChunks(rows.slice(mid), space, building)
        return
      }
      if (err instanceof OllamaError && (err.code === 'context_exceeded' || err.code === 'bad_response')) {
        if (building) this.buildFailed.contents.add(rows[0].content_id)
        else this.db.prepare("UPDATE contents SET embed_status = 'failed' WHERE id = ?").run(rows[0].content_id)
        return
      }
      this.embedBlockedUntil = Date.now() + 15_000
      if (err instanceof OllamaError) this.onAiFailure(err)
      return
    }
    noteSpaceFacts(this.db, space.id, { dims: vectors[0]?.length })
    // The space may have been swapped out or cancelled while Ollama was working; then the vectors are dropped.
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO chunk_vectors(space_id, chunk_id, vec) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM embedding_spaces WHERE id = ?)'
    )
    const units = vectors.map(toUnitVec)
    this.db.transaction(() => rows.forEach((r, i) => insert.run(space.id, r.id, vecToBuffer(units[i]), space.id)))()
    rows.forEach((r, i) => this.vectors.add(r.id, r.content_id, units[i], space.id))
  }

  // ---------- garbage collection ----------

  private gc(immediate: boolean): void {
    const now = Date.now()
    const removed = this.db.transaction(() => {
      this.db
        .prepare(
          'UPDATE contents SET orphaned_at = ? WHERE orphaned_at IS NULL AND NOT EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)'
        )
        .run(now)
      const doomed = 'orphaned_at IS NOT NULL AND orphaned_at <= ? AND NOT EXISTS (SELECT 1 FROM files WHERE content_id = contents.id)'
      const cutoff = immediate ? now : now - ORPHAN_GRACE_MS
      const ids = (this.db.prepare(`SELECT id FROM contents WHERE ${doomed}`).all(cutoff) as { id: number }[]).map((r) => r.id)
      if (ids.length) this.db.prepare(`DELETE FROM contents WHERE ${doomed}`).run(cutoff)
      return new Set(ids)
    })()
    if (removed.size > 0) {
      this.vectors.removeContents(removed)
      this.onChange()
    }
  }
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

function describeFailure(r: { status: string; skip_reason: string | null; error_code: string | null; extract_status: string | null; embed_status: string | null }): string {
  if (r.status === 'skipped' && r.skip_reason === 'too_large') return 'Too large to index'
  if (r.status === 'error') {
    if (r.error_code === 'locked') return 'File is locked by another program'
    if (r.error_code === 'access_denied') return 'Access denied'
    return 'Could not be read'
  }
  switch (r.extract_status) {
    case 'password_protected':
      return 'Password-protected'
    case 'no_text':
      return 'No text found (may be a scanned document)'
    case 'corrupt':
      return 'File appears to be damaged'
    case 'binary':
      return 'Not a text file'
    case 'timeout':
      return 'Took too long to read'
    case 'failed':
      return 'Could not extract text'
  }
  if (r.embed_status === 'failed') return 'Meaning index failed (keyword search still works)'
  return 'Unknown problem'
}
