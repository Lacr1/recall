import { useEffect, useMemo, useRef, useState } from 'react'
import type { DocumentView } from '../../../shared/types'
import { findTerms, queryTerms } from '../../../shared/text'
import { FileBadge, Highlighted } from '../components'
import { formatBytes, formatDate } from '../format'

export function DocumentPanel({ fileId, query, onClose }: { fileId: number; query: string; onClose: () => void }) {
  const [doc, setDoc] = useState<DocumentView | null>()
  const [matchIdx, setMatchIdx] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.recall.getDocument(fileId).then(setDoc)
  }, [fileId])

  const ranges = useMemo(() => (doc ? findTerms(doc.text, queryTerms(query)) : []), [doc, query])

  useEffect(() => {
    const marks = bodyRef.current?.querySelectorAll('mark')
    marks?.forEach((m, i) => m.classList.toggle('current', i === matchIdx))
    marks?.[matchIdx]?.scrollIntoView({ block: 'center' })
  }, [matchIdx, ranges])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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
              {ranges.length > 0 && (
                <span className="match-nav">
                  <button className="btn" aria-label="Previous match" onClick={() => setMatchIdx((i) => (i - 1 + ranges.length) % ranges.length)}>◀</button>
                  <span aria-live="polite">Match {matchIdx + 1} of {ranges.length}</span>
                  <button className="btn" aria-label="Next match" onClick={() => setMatchIdx((i) => (i + 1) % ranges.length)}>▶</button>
                </span>
              )}
            </div>
          </>
        )}
      </div>
      <div className="doc-body" ref={bodyRef}>
        {doc === undefined && <p className="muted">Loading…</p>}
        {doc === null && <p className="muted">This file is no longer in the index.</p>}
        {doc && (doc.text ? <Highlighted text={doc.text} ranges={ranges} /> : <p className="muted">No extracted text is available for this file.</p>)}
        {doc?.truncated && <p className="muted">… (preview truncated)</p>}
      </div>
    </div>
  )
}
