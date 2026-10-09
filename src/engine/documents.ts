import { statSync } from 'node:fs'
import type { DB } from './db'
import type { DocumentView, FileRef } from '../shared/types'

const MAX_VIEW_CHARS = 300_000

/** A passage to locate: a [start, end) window of a chunk's text, as search evidence gives it. */
export interface PassageRef {
  chunkId: number
  start: number
  end: number
}

export function readDocument(db: DB, fileId: number, wanted: PassageRef[] = []): DocumentView | null {
  const file = db
    .prepare(
      `SELECT x.id fileId, x.name, f.path || '\\' || x.rel_path path, f.path folderPath, x.ext, x.size, x.mtime_ms mtimeMs, x.content_id
       FROM files x JOIN folders f ON f.id = x.folder_id WHERE x.id = ?`
    )
    .get(fileId) as (FileRef & { content_id: number | null }) | undefined
  if (!file) return null
  const content = file.content_id
    ? (db.prepare('SELECT kind, title, extract_status, embed_status, page_count FROM contents WHERE id = ?').get(file.content_id) as
        | { kind: string; title: string | null; extract_status: string; embed_status: string; page_count: number | null }
        | undefined)
    : undefined
  const copies = file.content_id
    ? (db
        .prepare(
          `SELECT x.id fileId, x.name, f.path || '\\' || x.rel_path path, f.path folderPath, x.ext, x.size, x.mtime_ms mtimeMs
           FROM files x JOIN folders f ON f.id = x.folder_id WHERE x.content_id = ? AND x.id <> ?`
        )
        .all(file.content_id, fileId) as FileRef[])
    : []

  // Chunks are exact slices of the extracted text; stitch their non-overlapping parts.
  const chunks = file.content_id
    ? (db.prepare('SELECT id, text, char_start, char_end FROM chunks WHERE content_id = ? ORDER BY ord').all(file.content_id) as {
        id: number; text: string; char_start: number; char_end: number
      }[])
    : []
  const want = new Map(wanted.map((w) => [w.chunkId, w]))
  const passages: DocumentView['passages'] = []
  let text = ''
  let cursor = 0
  for (const c of chunks) {
    if (c.char_end > cursor && cursor > 0 && c.char_start > cursor) text += '\n\n'
    // Where the chunk starts in `text`: any part overlapping earlier chunks is already there, contiguously.
    const viewStart = text.length - Math.max(0, cursor - c.char_start)
    const w = want.get(c.id)
    if (w) passages.push({ chunkId: c.id, start: viewStart + w.start, end: viewStart + w.end })
    if (c.char_end <= cursor) continue
    text += c.text.slice(Math.max(cursor, c.char_start) - c.char_start)
    cursor = c.char_end
    if (text.length > MAX_VIEW_CHARS) break
  }

  let changed = false
  try {
    const s = statSync(file.path)
    changed = s.size !== file.size || Math.floor(s.mtimeMs) !== file.mtimeMs
  } catch {
    changed = true
  }

  const { content_id: _ignored, ...ref } = file
  return {
    file: ref,
    copies,
    title: content?.title ?? undefined,
    kind: content?.kind ?? 'unknown',
    status: statusLabel(content),
    pageCount: content?.page_count ?? undefined,
    text: text.slice(0, MAX_VIEW_CHARS),
    truncated: text.length > MAX_VIEW_CHARS,
    changedSinceIndexed: changed,
    passages: passages.filter((p) => p.end <= MAX_VIEW_CHARS).sort((a, b) => a.start - b.start)
  }
}

function statusLabel(c?: { extract_status: string; embed_status: string }): string {
  if (!c) return 'Waiting to be read'
  if (c.extract_status === 'pending') return 'Waiting to be read'
  if (c.extract_status !== 'ok') return 'Text could not be extracted'
  if (c.embed_status === 'done') return 'Keyword and meaning search ready'
  if (c.embed_status === 'failed') return 'Keyword search ready; meaning index failed'
  return 'Keyword search ready; meaning index pending'
}
