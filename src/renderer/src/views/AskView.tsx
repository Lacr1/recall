import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AskHistoryEntry } from '../../../shared/ask-history'
import type { AppStatus, AskEvent, AskSource } from '../../../shared/types'
import type { View } from '../App'
import { addAskEntry, clearAskHistory, loadAskHistory, removeAskEntry } from '../ask-history'
import { Logo } from '../components'
import { formatDate } from '../format'

let askCounter = 0

type AskState = 'idle' | 'running' | 'done' | 'insufficient' | 'error'

export function AskView({
  status,
  listeners,
  onNavigate,
  initialQuestion
}: {
  status: AppStatus
  listeners: Set<(e: AskEvent) => void>
  onNavigate: (v: View) => void
  /** Filled in by "Open in Recall" from the voice popup, ready to send or edit. */
  initialQuestion?: { text: string; n: number }
}) {
  const [question, setQuestion] = useState('')
  const [asked, setAsked] = useState<string>()
  const [sources, setSources] = useState<AskSource[]>([])
  const [answer, setAnswer] = useState('')
  const [state, setState] = useState<AskState>('idle')
  const [error, setError] = useState<string>()
  const [invalid, setInvalid] = useState<number[]>([])
  const [history, setHistory] = useState(loadAskHistory)
  // A saved answer picked from the history; when unset, the live question is shown.
  const [selectedId, setSelectedId] = useState<string>()
  // The history entry the live question was saved as, so it stays highlighted.
  const [liveId, setLiveId] = useState<string>()
  const currentId = useRef(0)
  // The listener below is registered once, so the live answer is mirrored here for saving when it finishes.
  const pending = useRef<{ id: string; question: string; model: string; sources: AskSource[]; answer: string }>(undefined)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (initialQuestion) setQuestion(initialQuestion.text)
  }, [initialQuestion?.n])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [selectedId])

  const save = (insufficient: boolean, invalidCitations: number[]) => {
    const p = pending.current
    if (!p || (!p.answer && !insufficient)) return
    const entry: AskHistoryEntry = { ...p, insufficient, invalidCitations, at: Date.now() }
    setHistory((list) => addAskEntry(list, entry))
    setLiveId(p.id)
  }

  useEffect(() => {
    const l = (e: AskEvent) => {
      if (e.askId !== currentId.current) return
      const p = pending.current
      if (e.type === 'sources') {
        setSources(e.sources)
        if (p) p.sources = e.sources
      } else if (e.type === 'token') {
        setAnswer(e.text)
        if (p) p.answer = e.text
      } else if (e.type === 'done') {
        setInvalid(e.invalidCitations)
        setState(e.insufficient ? 'insufficient' : 'done')
        save(e.insufficient, e.invalidCitations)
      } else if (e.type === 'error') {
        setError(e.message)
        setState('error')
      }
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [listeners])

  const resetLive = () => {
    setAsked(undefined)
    setSources([])
    setAnswer('')
    setError(undefined)
    setInvalid([])
    setLiveId(undefined)
    setState('idle')
  }

  const submit = () => {
    const q = question.trim()
    if (!q || state === 'running') return
    const id = ++askCounter
    currentId.current = id
    pending.current = { id: `${Date.now()}-${id}`, question: q, model: status.ai.chatModel, sources: [], answer: '' }
    resetLive()
    setSelectedId(undefined)
    setAsked(q)
    setQuestion('')
    setState('running')
    void window.recall.ask(id, q)
  }

  const stop = () => {
    void window.recall.cancelAsk(currentId.current)
    setState('done')
    save(false, invalid)
  }

  const newQuestion = () => {
    setSelectedId(undefined)
    if (state !== 'running') resetLive()
    setQuestion('')
    inputRef.current?.focus()
  }

  const remove = (id: string) => {
    setHistory((list) => removeAskEntry(list, id))
    if (selectedId === id) setSelectedId(undefined)
    if (liveId === id && state !== 'running') resetLive()
  }

  const clear = () => {
    setHistory(clearAskHistory())
    setSelectedId(undefined)
    if (state !== 'running') resetLive()
  }

  const unavailable = status.ai.state !== 'ready' || !status.ai.chatAvailable
  const viewing = selectedId ? history.find((e) => e.id === selectedId) : undefined
  const activeId = selectedId ?? liveId

  return (
    <div className="ask-view">
      <div className="ask-main">
        <div className="ask-scroll" ref={scrollRef}>
          <div className="ask-body">
            <h1 className="view-title">Ask Reca about your files</h1>
            {unavailable && (
              <div className="banner banner-warn" role="status">
                {status.ai.state !== 'ready' ? 'Reca needs local AI to be running.' : `The answer model (${status.ai.chatModel}) isn’t installed in Ollama.`}
                <button className="link" onClick={() => onNavigate('settings')}>Local AI settings</button>
              </div>
            )}

            <RecaMessage>
              <p className="reca-welcome">
                Hi, I’m Reca! Ask me anything about the files in your folders. I answer only from passages I find in
                them and show you where each part came from, so you can check. Everything stays on this computer.
              </p>
            </RecaMessage>

            {viewing ? (
              <AnswerCard
                key={viewing.id}
                question={viewing.question}
                answer={viewing.answer}
                sources={viewing.sources}
                state={viewing.insufficient ? 'insufficient' : 'done'}
                invalid={viewing.invalidCitations}
                model={viewing.model}
              />
            ) : (
              asked && (
                <AnswerCard
                  key={currentId.current}
                  question={asked}
                  answer={answer}
                  sources={sources}
                  state={state}
                  error={error}
                  invalid={invalid}
                  model={status.ai.chatModel}
                  live
                />
              )
            )}
          </div>
        </div>
        <div className="ask-composer">
          <form
            className="ask-form"
            onSubmit={(e) => {
              e.preventDefault()
              submit()
            }}
          >
            <input
              ref={inputRef}
              className="text-input ask-input"
              aria-label="Ask a question about your files"
              placeholder="e.g. What payment terms did I propose to Acme?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={unavailable}
              autoFocus
            />
            {state === 'running' ? (
              <button type="button" className="btn" onClick={stop}>Stop</button>
            ) : (
              <button type="submit" className="btn btn-primary" disabled={unavailable || !question.trim()}>Ask</button>
            )}
          </form>
        </div>
      </div>

      <aside className="ask-history" aria-labelledby="ask-history-heading">
        <div className="ask-history-head">
          <h2 id="ask-history-heading" className="section-label">History</h2>
          {history.length > 0 && <button className="link" onClick={clear}>Clear</button>}
        </div>
        <button className="btn ask-new" onClick={newQuestion}>New question</button>
        {history.length === 0 ? (
          <p className="muted small ask-history-empty">Questions you ask Reca appear here.</p>
        ) : (
          <ul className="ask-history-list">
            {history.map((e) => (
              <li key={e.id} className={e.id === activeId ? 'active' : undefined}>
                <button className="ask-history-item" aria-current={e.id === activeId ? 'true' : undefined} onClick={() => setSelectedId(e.id)}>
                  <span className="ask-history-q">{e.question}</span>
                  <span className="ask-history-when">{formatWhen(e.at)}</span>
                </button>
                <button className="ask-history-remove" aria-label={`Remove “${e.question}” from history`} onClick={() => remove(e.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}

/** Time of day for today's questions, the date for older ones. */
function formatWhen(ms: number): string {
  const d = new Date(ms)
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return formatDate(ms)
}

function AnswerCard({
  question,
  answer,
  sources,
  state,
  error,
  invalid,
  model,
  live = false
}: {
  question: string
  answer: string
  sources: AskSource[]
  state: AskState
  error?: string
  invalid: number[]
  model: string
  /** Announce the answer as it streams in; a saved answer opened from the history is not announced. */
  live?: boolean
}) {
  const [focusSource, setFocusSource] = useState<number>()
  return (
    <>
      <div className="ask-user">
        <span className="sr-only">You asked: </span>
        <p className="answer-q">{question}</p>
      </div>
      <RecaMessage live={live}>
        {state === 'running' && !answer && <p className="muted">{sources.length ? 'Reading the sources…' : 'Finding relevant passages…'}</p>}
        {state === 'insufficient' && (
          <p className="insufficient">I couldn’t find enough in your files to answer this confidently.{sources.length > 0 && ' These are the closest passages:'}</p>
        )}
        {state === 'error' && <p className="error">{error}</p>}
        {answer && state !== 'insufficient' && (
          <div className="answer-text">{renderAnswer(answer, sources.length, (n) => setFocusSource(n))}</div>
        )}
        {invalid.length > 0 && (
          <p className="small warn">Removed citations to sources that don’t exist: {invalid.map((n) => `[${n}]`).join(' ')}</p>
        )}
        {sources.length > 0 && (() => {
          // Once answered, show the cited sources first; the rest were retrieved but not used.
          const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))
          const answered = state === 'done' && cited.size > 0
          const primary = answered ? sources.filter((s) => cited.has(s.n)) : sources
          const others = answered ? sources.filter((s) => !cited.has(s.n)) : []
          return (
            <>
              <h2 className="section-label">{answered ? 'Cited sources' : 'Sources'}</h2>
              <SourceList sources={primary} focus={focusSource} />
              {others.length > 0 && (
                <details className="other-sources">
                  <summary>Other passages considered ({others.length})</summary>
                  <SourceList sources={others} focus={focusSource} />
                </details>
              )}
            </>
          )
        })()}
        {state === 'done' && answer && (
          <p className="disclaimer">Generated locally by {model}. It can be wrong, so check the sources.</p>
        )}
      </RecaMessage>
    </>
  )
}

/** One of Reca's messages, with the mascot's head beside it like a chat. */
function RecaMessage({ live = false, children }: { live?: boolean; children: ReactNode }) {
  return (
    <div className="reca-msg">
      <Logo size={40} className="reca-head" />
      <section className="reca-bubble" aria-live={live ? 'polite' : undefined}>
        <span className="sr-only">Reca: </span>
        {children}
      </section>
    </div>
  )
}

/**
 * Turns [n] into citation chips and marks "Inferred:" sentences wherever they start in a paragraph.
 * Invalid citations are dropped.
 */
function renderAnswer(text: string, sourceCount: number, onCite: (n: number) => void): ReactNode[] {
  const withCitations = (sentence: string) =>
    sentence.split(/(\[\d+\])/g).map((part, i) => {
      const m = /^\[(\d+)\]$/.exec(part)
      if (!m) return part
      const n = Number(m[1])
      if (n < 1 || n > sourceCount) return null
      return (
        <button key={i} className="cite-chip" onClick={() => onCite(n)} aria-label={`Source ${n}`}>
          {n}
        </button>
      )
    })
  return text.split(/\n+/).map((para, pi) => (
    <p key={pi}>
      {para.split(/(?<=[.!?]\s+)(?=Inferred:)/i).map((sentence, si) => (
        <span key={si} className={/^\s*Inferred:/i.test(sentence) ? 'inferred' : undefined}>
          {withCitations(sentence)}
        </span>
      ))}
    </p>
  ))
}

function SourceList({ sources, focus }: { sources: AskSource[]; focus?: number }) {
  return (
    <ol className="sources">
      {sources.map((s) => (
        <li key={s.n} className={focus === s.n ? 'focused' : ''}>
          <div className="source-head">
            <span className="cite">[{s.n}]</span>
            <button className="link" onClick={() => void window.recall.openFile(s.fileId)}>{s.name}</button>
            {s.location && <span className="muted small"> · {s.location}</span>}
          </div>
          <div className="source-snippet">{s.snippet}</div>
        </li>
      ))}
    </ol>
  )
}
