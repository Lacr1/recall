import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppStatus, SearchResponse, SearchResult } from '../../../shared/types'
import type { View } from '../App'
import { FileBadge, Highlighted } from '../components'
import { formatDate, plural, shortFolder } from '../format'
import { DocumentPanel } from './DocumentPanel'
import { indexingLabel } from './StatusBar'

const EXAMPLES = ['proposal with a 50% initial payment', 'notes about improving the booking system', 'where I implemented authentication']

let requestCounter = 0

export function SearchView({ status, onNavigate }: { status: AppStatus; onNavigate: (v: View) => void }) {
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<SearchResponse>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState(0)
  const [detailFileId, setDetailFileId] = useState<number>()
  const [notice, setNotice] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const run = useCallback(async (q: string) => {
    if (!q.trim()) {
      setResponse(undefined)
      return
    }
    const id = ++requestCounter
    setLoading(true)
    setError(undefined)
    try {
      const res = await window.recall.search(id, q)
      if (id !== requestCounter || !res) return
      setResponse(res)
      setSelected(0)
    } catch {
      if (id === requestCounter) setError('Search failed. Try again.')
    } finally {
      if (id === requestCounter) setLoading(false)
    }
  }, [])

  // Debounced search-as-you-type.
  useEffect(() => {
    const t = setTimeout(() => void run(query), 250)
    return () => clearTimeout(t)
  }, [query, run])

  // Refresh results when indexing finishes more files, so new matches appear.
  const doneCount = status.progress.readDone + status.progress.embedDone
  useEffect(() => {
    if (query.trim()) void run(query)
  }, [doneCount > 0 ? Math.floor(doneCount / 25) : 0])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const results = response?.results ?? []
  const current: SearchResult | undefined = results[selected]

  const open = async (r?: SearchResult) => {
    if (!r) return
    const res = await window.recall.openFile(r.primary.fileId)
    setNotice(res.ok ? undefined : res.message)
  }
  const reveal = async (r?: SearchResult) => {
    if (!r) return
    const res = await window.recall.revealFile(r.primary.fileId)
    setNotice(res.ok ? undefined : res.message)
  }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((s) => Math.min(results.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      void reveal(current)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void open(current)
    } else if (e.key === 'Escape') {
      setQuery('')
      inputRef.current?.focus()
    }
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const idx = indexingLabel(status)
  const aiOff = status.ai.state !== 'ready'
  const noFolders = status.folders.length === 0

  return (
    <div className="search-view">
      <h1 className="sr-only">Search your files</h1>
      <div className="search-header">
        <div className="search-box">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
            <path d="M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" />
          </svg>
          <input
            ref={inputRef}
            role="searchbox"
            aria-label="Search your files"
            placeholder="Describe what you're looking for…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onListKey}
          />
          {query && (
            <button className="clear-btn" aria-label="Clear search" onClick={() => { setQuery(''); inputRef.current?.focus() }}>
              ×
            </button>
          )}
          <kbd>Ctrl K</kbd>
        </div>
        {aiOff && (
          <div className="banner banner-warn" role="status">
            Meaning-based search is off — {status.ai.state === 'model_missing' ? 'the search model isn’t downloaded' : 'Ollama isn’t running'}.
            Keyword search still works.
            <button className="link" onClick={() => onNavigate('settings')}>Set up local AI</button>
          </div>
        )}
        {response?.partialIndex && idx.busy && (
          <div className="banner banner-info" role="status">Still indexing — results may be incomplete ({idx.text.toLowerCase()}).</div>
        )}
        {notice && (
          <div className="banner banner-warn" role="alert">
            {notice}
            <button className="link" onClick={() => setNotice(undefined)}>Dismiss</button>
          </div>
        )}
      </div>

      {!query.trim() ? (
        <div className="empty-state">
          {noFolders ? (
            <>
              <h2>Recall doesn’t have any folders yet</h2>
              <button className="btn btn-primary" onClick={() => onNavigate('folders')}>Add a folder</button>
            </>
          ) : (
            <>
              <h2>Search by what you remember</h2>
              <p className="muted">You don’t need the file name — describe what was in it.</p>
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => setQuery(ex)}>“{ex}”</button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="results-layout">
          <section className={`results ${loading ? 'loading' : ''}`} aria-label="Results">
            <div className="results-meta" aria-live="polite">
              {error ? (
                <span className="error">{error}</span>
              ) : response ? (
                <>
                  {plural(response.results.length, 'file')} · {response.mode === 'hybrid' ? 'meaning + keywords' : 'keywords only'} · {response.tookMs} ms
                </>
              ) : (
                'Searching…'
              )}
            </div>
            {response && results.length === 0 && (
              <div className="no-results">
                <h3>No files matched “{response.query}”</h3>
                <ul className="muted">
                  <li>Try fewer or different words.</li>
                  {response.mode === 'keyword' && <li>Turn on local AI to search by meaning.</li>}
                  {idx.busy && <li>Some files are still being indexed.</li>}
                </ul>
              </div>
            )}
            {response?.lowConfidence && results.length > 0 && (
              <div className="low-confidence">Closest matches — none are a strong match.</div>
            )}
            <ul ref={listRef} className="result-list" role="listbox" aria-label="Matching files" tabIndex={-1} onKeyDown={onListKey}>
              {results.map((r, i) => (
                <li
                  key={r.contentId}
                  role="option"
                  aria-selected={i === selected}
                  className={`result ${i === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(i)}
                  onDoubleClick={() => void open(r)}
                >
                  <div className="result-head">
                    <FileBadge ext={r.primary.ext} />
                    <span className="result-name">{r.primary.name}</span>
                    {r.copies.length > 0 && <span className="pill">{r.copies.length + 1} copies</span>}
                  </div>
                  <div className="result-sub">
                    <span className="mono">{shortFolder(r.primary.path)}</span> · {formatDate(r.primary.mtimeMs)}
                    {r.evidence[0]?.location && <> · {r.evidence[0].location}</>}
                  </div>
                  {r.evidence[0] && (
                    <p className="result-snippet">
                      <Highlighted text={r.evidence[0].snippet} ranges={r.evidence[0].highlights} />
                    </p>
                  )}
                  <Reasons r={r} />
                </li>
              ))}
            </ul>
          </section>

          <aside className="evidence" aria-label="Evidence">
            {current ? (
              <>
                <div className="evidence-head">
                  <div className="evidence-title">
                    <FileBadge ext={current.primary.ext} />
                    <h2>{current.primary.name}</h2>
                  </div>
                  <div className="mono small muted break">{current.primary.path}</div>
                  <div className="small muted">Modified {formatDate(current.primary.mtimeMs)}</div>
                  <div className="evidence-actions">
                    <button className="btn btn-primary" onClick={() => void open(current)}>Open</button>
                    <button className="btn" onClick={() => void reveal(current)}>Show in folder</button>
                    <button className="btn" onClick={() => void window.recall.copyPath(current.primary.fileId)}>Copy path</button>
                    <button className="btn" onClick={() => setDetailFileId(current.primary.fileId)}>Details</button>
                  </div>
                </div>
                <h3 className="section-label">Why it matched</h3>
                <ul className="why">
                  {current.reasons.map((reason, i) => (
                    <li key={i}>{reasonText(reason)}</li>
                  ))}
                  {current.reasons.length === 0 && <li>Closest available match</li>}
                </ul>
                <h3 className="section-label">Passages</h3>
                {current.evidence.map((ev) => (
                  <blockquote key={ev.chunkId} className="passage">
                    {ev.location && <div className="passage-loc">{ev.location}</div>}
                    <Highlighted text={ev.snippet} ranges={ev.highlights} />
                  </blockquote>
                ))}
                {current.copies.length > 0 && (
                  <>
                    <h3 className="section-label">Also at</h3>
                    <ul className="copies">
                      {current.copies.map((c) => (
                        <li key={c.fileId} className="mono small break">{c.path}</li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            ) : (
              <p className="muted">Select a result to see why it matched.</p>
            )}
          </aside>
        </div>
      )}

      {detailFileId !== undefined && (
        <DocumentPanel fileId={detailFileId} query={query} onClose={() => setDetailFileId(undefined)} />
      )}
    </div>
  )
}

function Reasons({ r }: { r: SearchResult }) {
  return (
    <div className="reasons">
      {r.reasons.map((reason, i) => (
        <span key={i} className={`reason reason-${reason.kind}`}>
          {reasonText(reason)}
        </span>
      ))}
    </div>
  )
}

function reasonText(reason: SearchResult['reasons'][number]): string {
  switch (reason.kind) {
    case 'terms':
      return `Contains ${reason.terms.slice(0, 4).map((t) => `“${t}”`).join(', ')}`
    case 'meaning':
      return `Similar meaning${reason.location ? ` (${reason.location})` : ''}`
    case 'filename':
      return 'File name match'
  }
}
