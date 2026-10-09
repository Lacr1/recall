import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentView, Evidence, HighlightRange } from '../../../shared/types'
import { findTerms, queryTerms } from '../../../shared/text'
import { FileBadge, Highlighted } from '../components'
import { formatBytes, formatDate } from '../format'

export function DocumentPanel({
  fileId,
  query,
  evidence = [],
  startChunkId,
  onClose
}: {
  fileId: number
  query: string
  /** The result's passages; they are marked in the text and can be stepped through (S4-05). */
  evidence?: Evidence[]
  /** Opens at this passage; otherwise at the first one, or the first matched word when there are none. */
  startChunkId?: number
  onClose: () => void
}) {
  const [doc, setDoc] = useState<DocumentView | null>()
  // Both stay undefined until there is something to show, so opening doesn't scroll twice.
  const [matchIdx, setMatchIdx] = useState<number>()
  const [passageIdx, setPassageIdx] = useState<number>()
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const refs = evidence.map((e) => ({ chunkId: e.chunkId, start: e.chunkStart, end: e.chunkEnd }))
    void window.recall.getDocument(fileId, refs).then(setDoc)
  }, [fileId])

  const ranges = useMemo(() => (doc ? findTerms(doc.text, queryTerms(query)) : []), [doc, query])
  const passages = doc?.passages ?? []

  useEffect(() => {
    if (!doc) return
    const start = passages.findIndex((p) => p.chunkId === startChunkId)
    if (passages.length) setPassageIdx(start >= 0 ? start : 0)
    else if (ranges.length) setMatchIdx(0)
  }, [doc])

  useEffect(() => {
    const marks = bodyRef.current?.querySelectorAll('mark')
    marks?.forEach((m, i) => m.classList.toggle('current', i === matchIdx))
    if (matchIdx !== undefined) marks?.[matchIdx]?.scrollIntoView({ block: 'center' })
  }, [matchIdx, ranges])

  useEffect(() => {
    const els = bodyRef.current?.querySelectorAll<HTMLElement>('[data-passage]')
    els?.forEach((el) => el.classList.toggle('current', Number(el.dataset.passage) === passageIdx))
    if (passageIdx !== undefined) bodyRef.current?.querySelector(`[data-passage="${passageIdx}"]`)?.scrollIntoView({ block: 'center' })
  }, [passageIdx, doc])

  const step = (i: number | undefined, d: number, n: number) => (i === undefined ? (d > 0 ? 0 : n - 1) : (i + d + n) % n)
  const stepMatch = (d: number) => setMatchIdx((i) => step(i, d, ranges.length))
  const stepPassage = (d: number) => setPassageIdx((i) => step(i, d, passages.length))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'F3' && ranges.length) {
        e.preventDefault()
        stepMatch(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, ranges.length])

  const location = (i?: number) => (i === undefined ? undefined : evidence.find((e) => e.chunkId === passages[i]?.chunkId)?.location)

  return (
    <div className="doc-panel" role="dialog" aria-modal="true" aria-label="Document details">
      <div className="doc-head">
        <button className="btn" onClick={onClose} autoFocus>← Back to results</button>
        {doc && (
          <>
            <div className="evidence-title">
              <FileBadge ext={doc.file.ext} />
              <h2>{doc.title && doc.title !== doc.file.name ? `${doc.file.name} · ${doc.title}` : doc.file.name}</h2>
            </div>
            <div className="mono small muted break">{doc.file.path}</div>
            <div className="small muted">
              {doc.kind.toUpperCase()} · {formatBytes(doc.file.size)} · Modified {formatDate(doc.file.mtimeMs)}
              {doc.pageCount ? ` · ${doc.pageCount} pages` : ''} · {doc.status}
            </div>
            {doc.changedSinceIndexed && (
              <div className="banner banner-warn">This file changed after it was indexed. Recall will pick up the change shortly.</div>
            )}
            {doc.copies.length > 0 && <div className="small muted">Also at: {doc.copies.map((c) => c.path).join(' · ')}</div>}
            <div className="evidence-actions">
              <button className="btn btn-primary" onClick={() => void window.recall.openFile(fileId)}>Open</button>
              <button className="btn" onClick={() => void window.recall.revealFile(fileId)}>Show in folder</button>
              {passages.length > 0 && (
                <span className="match-nav" role="group" aria-label="Matching passages">
                  <button className="btn" aria-label="Previous passage" onClick={() => stepPassage(-1)}>◀</button>
                  <span aria-live="polite">
                    Passage {(passageIdx ?? 0) + 1} of {passages.length}
                    {location(passageIdx) && <span className="muted"> · {location(passageIdx)}</span>}
                  </span>
                  <button className="btn" aria-label="Next passage" onClick={() => stepPassage(1)}>▶</button>
                </span>
              )}
              {ranges.length > 0 && (
                <span className="match-nav" role="group" aria-label="Matched words">
                  <button className="btn" aria-label="Previous match" aria-keyshortcuts="Shift+F3" onClick={() => stepMatch(-1)}>◀</button>
                  <span aria-live="polite">
                    {matchIdx === undefined ? `${ranges.length} matched word${ranges.length === 1 ? '' : 's'}` : `Match ${matchIdx + 1} of ${ranges.length}`}
                  </span>
                  <button className="btn" aria-label="Next match" aria-keyshortcuts="F3" onClick={() => stepMatch(1)}>▶</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="doc-body" ref={bodyRef}>
        {doc === undefined && <p className="muted">Loading…</p>}
        {doc === null && <p className="muted">This file is no longer in the index.</p>}
        {doc &&
          (doc.text ? <DocText text={doc.text} marks={ranges} passages={passages} /> : <p className="muted">No extracted text is available for this file.</p>)}
        {doc?.truncated && <p className="muted">… (preview truncated)</p>}
      </div>
    </div>
  )
}

/** The document text with passages wrapped in tinted spans and matched words in <mark>, text nodes only. */
function DocText({ text, marks, passages }: { text: string; marks: HighlightRange[]; passages: HighlightRange[] }) {
  const piece = (from: number, to: number) => (
    <Highlighted
      text={text.slice(from, to)}
      ranges={marks.filter((m) => m.end > from && m.start < to).map((m) => ({ start: Math.max(m.start, from) - from, end: Math.min(m.end, to) - from }))}
    />
  )
  const out = []
  let pos = 0
  passages.forEach((p, i) => {
    // Passages of neighbouring chunks can overlap; each starts where the previous one ended.
    const start = Math.max(p.start, pos)
    if (start >= p.end) return
    if (start > pos) out.push(<Fragment key={`t${i}`}>{piece(pos, start)}</Fragment>)
    out.push(
      <span key={`p${i}`} className="doc-passage" data-passage={i}>
        {piece(start, p.end)}
      </span>
    )
    pos = p.end
  })
  if (pos < text.length) out.push(<Fragment key="end">{piece(pos, text.length)}</Fragment>)
  return <>{out}</>
}
