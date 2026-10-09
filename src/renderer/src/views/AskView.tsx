import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppStatus, AskEvent, AskSource } from '../../../shared/types'
import type { View } from '../App'

let askCounter = 0

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
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'insufficient' | 'error'>('idle')
  const [error, setError] = useState<string>()
  const [invalid, setInvalid] = useState<number[]>([])
  const [focusSource, setFocusSource] = useState<number>()
  const currentId = useRef(0)

  useEffect(() => {
    if (initialQuestion) setQuestion(initialQuestion.text)
  }, [initialQuestion?.n])

  useEffect(() => {
    const l = (e: AskEvent) => {
      if (e.askId !== currentId.current) return
      if (e.type === 'sources') setSources(e.sources)
      else if (e.type === 'token') setAnswer(e.text)
      else if (e.type === 'done') {
        setInvalid(e.invalidCitations)
        setState(e.insufficient ? 'insufficient' : 'done')
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

  const submit = () => {
    const q = question.trim()
    if (!q || state === 'running') return
    const id = ++askCounter
    currentId.current = id
    setAsked(q)
    setSources([])
    setAnswer('')
    setError(undefined)
    setInvalid([])
    setFocusSource(undefined)
    setState('running')
    void window.recall.ask(id, q)
  }

  const stop = () => {
    void window.recall.cancelAsk(currentId.current)
    setState('done')
  }

  const unavailable = status.ai.state !== 'ready' || !status.ai.chatAvailable

  return (
    <div className="ask-view">
      <h1 className="view-title">Ask your files</h1>
      <p className="muted">Answers come only from passages Recall finds in your files, generated on this computer.</p>
      {unavailable && (
        <div className="banner banner-warn" role="status">
          {status.ai.state !== 'ready' ? 'Ask needs local AI to be running.' : `The answer model (${status.ai.chatModel}) isn’t installed in Ollama.`}
          <button className="link" onClick={() => onNavigate('settings')}>Local AI settings</button>
        </div>
      )}
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input
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

      {asked && (
        <section className="answer-card" aria-live="polite">
          <div className="answer-q">{asked}</div>
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
            <p className="disclaimer">Generated locally by {status.ai.chatModel}. It can be wrong, so check the sources.</p>
          )}
        </section>
      )}
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
