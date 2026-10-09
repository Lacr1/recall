import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { AppStatus, SearchResponse, SearchResult } from '../../../shared/types'
import type { View } from '../App'
import { FileBadge, Highlighted } from '../components'
import { formatDate, plural, shortFolder } from '../format'
import { addRecent, clearRecent, loadRecent, removeRecent } from '../recent'
import { DocumentPanel } from './DocumentPanel'
import { indexingLabel } from './StatusBar'

const EXAMPLES = ['proposal with a 50% initial payment', 'notes about improving the booking system', 'where I implemented authentication']

const RECENT_AFTER_MS = 1500

let requestCounter = 0
// Kept across visits to the search screen so the examples don't flash back to the generic ones.
let lastSuggestions: string[] = []

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

  // Examples come from the user's own files. While indexing, they are refreshed (at most once a second) as
  // more files are read, until there are enough; adding or removing a folder starts that again.
  const [suggestions, setSuggestions] = useState(lastSuggestions)
  const suggestionsDoneFor = useRef<number | undefined>(undefined)
  const suggestionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const folderCount = status.folders.length
  useEffect(() => {
    if (suggestionsDoneFor.current === folderCount || suggestionTimer.current) return
    const delay = suggestionsDoneFor.current === undefined && !lastSuggestions.length ? 0 : 1000
    suggestionTimer.current = setTimeout(() => {
      window.recall
        .getSearchSuggestions()
        .then((list) => {
          lastSuggestions = list
          setSuggestions(list)
          if (list.length >= 3) suggestionsDoneFor.current = folderCount
        })
        .catch(() => undefined)
        .finally(() => (suggestionTimer.current = undefined))
    }, delay)
  }, [status.progress.readDone, folderCount])
  useEffect(() => () => clearTimeout(suggestionTimer.current), [])

  // The search box sits under the heading on the empty screen and at the top once there is a query.
  // The layout follows the query a frame later, inside a view transition that slides the box between the
  // two places. The query itself always updates at once, so fast typing never loses a keystroke.
  const wantHome = !query.trim()
  const [home, setHome] = useState(wantHome)
  const wantHomeRef = useRef(wantHome)
  wantHomeRef.current = wantHome
  useEffect(() => {
    if (wantHome === home) return
    // Reads the ref, not wantHome: the query may have changed back before the transition runs this.
    const apply = () => setHome(wantHomeRef.current)
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(() => flushSync(apply))
    } else {
      apply()
    }
  }, [wantHome])

  const results = response?.results ?? []
  const current: SearchResult | undefined = results[selected]
  // Placeholders until the first answer for this query arrives. While refining a query that already has
  // results, those stay on screen (dimmed) instead.
  const skeleton = !error && (!response || (loading && results.length === 0))

  // A search counts as "recent" once it has results and the query has rested for a moment, or as soon as
  // a result is opened, so the half-typed steps of a query don't fill the list.
  const [recent, setRecent] = useState(loadRecent)
  const remember = (q: string) => setRecent((list) => addRecent(list, q))
  useEffect(() => {
    if (!response?.results.length || response.query.trim() !== query.trim()) return
    const t = setTimeout(() => remember(response.query), RECENT_AFTER_MS)
    return () => clearTimeout(t)
  }, [response, query])

  const open = async (r?: SearchResult) => {
    if (!r) return
    remember(query)
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

  // The clicked chip disappears with the empty screen, so focus moves to the search box to keep the keyboard
  // flow (arrows, Enter, Escape) working.
  const pick = (q: string) => {
    setQuery(q)
    inputRef.current?.focus()
  }

  const idx = indexingLabel(status)
  const aiOff = status.ai.state !== 'ready'
  const noFolders = status.folders.length === 0

  return (
    <div className={`search-view ${home ? 'home' : ''}`}>
      <h1 className="sr-only">Search your files</h1>
      <div className="search-header">
        {home && (
          <div className="home-intro">
            {noFolders ? (
              <h2>Recall doesn’t have any folders yet</h2>
            ) : (
              <>
                <h2>Search by what you remember</h2>
                <p className="muted">You don’t need the file name. Just describe what was in it.</p>
              </>
            )}
          </div>
        )}
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
            Meaning-based search is off because {status.ai.state === 'model_missing' ? 'the search model isn’t downloaded' : 'Ollama isn’t running'}.
            Keyword search still works.
            <button className="link" onClick={() => onNavigate('settings')}>Set up local AI</button>
          </div>
        )}
        {response?.partialIndex && idx.busy && (
          <div className="banner banner-info" role="status">Still indexing, so results may be incomplete ({idx.text.toLowerCase()}).</div>
        )}
        {notice && (
          <div className="banner banner-warn" role="alert">
            {notice}
            <button className="link" onClick={() => setNotice(undefined)}>Dismiss</button>
          </div>
        )}
        {home &&
          (noFolders ? (
            <button className="btn btn-primary" onClick={() => onNavigate('folders')}>Add a folder</button>
          ) : (
            <>
              <div className="examples" role="group" aria-label="Example searches">
                {(suggestions.length ? suggestions : EXAMPLES).map((ex) => (
                  <button key={ex} className="chip" onClick={() => pick(ex)}>“{ex}”</button>
                ))}
              </div>
              {recent.length > 0 && (
                <section className="recent" aria-labelledby="recent-heading">
                  <div className="recent-head">
                    <h2 id="recent-heading" className="section-label">Recent searches</h2>
                    <button className="link" onClick={() => setRecent(clearRecent())}>Clear</button>
                  </div>
                  <ul>
                    {recent.map((q) => (
                      <li key={q}>
                        <button className="recent-query" onClick={() => pick(q)}>
                          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
                            <path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 3v4.59l3.2 3.2-1.4 1.42L11 12.4V7h2Z" />
                          </svg>
                          {q}
                        </button>
                        <button className="recent-remove" aria-label={`Remove “${q}” from recent searches`} onClick={() => setRecent((list) => removeRecent(list, q))}>
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ))}
      </div>

      {!home && (
        <div className="results-layout">
          <section className={`results ${loading && !skeleton ? 'loading' : ''}`} aria-label="Results" aria-busy={loading}>
            <div className="results-meta" aria-live="polite">
              {error ? (
                <span className="error">{error}</span>
              ) : skeleton ? (
                <>
                  <span className="sr-only">Searching…</span>
                  <span className="sk sk-meta" aria-hidden="true" />
                </>
              ) : (
                response && (
                  <>
                    {plural(response.results.length, 'file')} · {response.mode === 'hybrid' ? 'meaning + keywords' : 'keywords only'} · {response.tookMs} ms
                  </>
                )
              )}
            </div>
            {skeleton && <ResultSkeletons />}
            {response && results.length === 0 && !skeleton && (
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
              <div className="low-confidence">No strong matches. These are the closest.</div>
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
            ) : skeleton ? (
              <EvidenceSkeleton />
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

// Placeholders shaped like the result cards and evidence panel, shown while a search has nothing to show yet.
function ResultSkeletons() {
  return (
    <ul className="result-list" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <li key={i} className="result skeleton-card">
          <div className="result-head">
            <span className="sk sk-badge" />
            <span className="sk sk-name" style={{ width: `${[46, 58, 38, 52, 42][i]}%` }} />
          </div>
          <span className="sk sk-sub" />
          <span className="sk sk-line" />
          <span className="sk sk-line" />
          <span className="sk sk-line sk-short" />
          <div className="reasons">
            <span className="sk sk-pill" />
            <span className="sk sk-pill" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function EvidenceSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="evidence-head">
        <div className="evidence-title">
          <span className="sk sk-badge" />
          <span className="sk sk-heading" />
        </div>
        <span className="sk sk-sub sk-wide" />
        <span className="sk sk-sub" />
        <div className="evidence-actions">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="sk sk-button" />
          ))}
        </div>
      </div>
      <span className="sk sk-label" />
      <span className="sk sk-line" />
      <span className="sk sk-line sk-short" />
      <span className="sk sk-label" />
      <span className="sk sk-passage" />
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
