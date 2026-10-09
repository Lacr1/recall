import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PopupItem, PopupSource, PopupState, PopupView, RecallPopupApi } from '../../../shared/popup'
import { FileBadge } from '../components'
import * as copy from '../../../shared/popup-copy'
import { speak, stopSpeaking } from './speech'

declare global {
  interface Window {
    recallPopup: RecallPopupApi
  }
}

const api = () => window.recallPopup
const act = (a: Parameters<RecallPopupApi['action']>[0]) => void api().action(a).catch(() => undefined)

export function Popup() {
  const [state, setState] = useState<PopupState>()
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => api().onState(setState), [])

  // Main sizes the window to the card, so the transparent window never blocks clicks around it.
  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    const ro = new ResizeObserver(() => act({ type: 'resize', height: card.offsetHeight }))
    ro.observe(card)
    return () => ro.disconnect()
    // The card is re-created on every show (it is keyed by showCount), so observe the new one.
  }, [state?.showCount])

  useSpokenReply(state)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') act({ type: 'dismiss' })
      else if (state?.view.kind === 'files' && /^[1-5]$/.test(e.key)) act({ type: 'select', index: Number(e.key) - 1 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state?.view.kind])

  if (!state) return null
  const { view } = state

  return (
    <div
      className="card"
      ref={cardRef}
      role="dialog"
      aria-label="Recall"
      key={state.showCount}
      onMouseEnter={() => act({ type: 'hover', on: true })}
      onMouseLeave={() => act({ type: 'hover', on: false })}
    >
      <Header state={state} />
      <div className="body" key={view.kind} aria-live="polite">
        <Body view={view} showCount={state.showCount} />
      </div>
    </div>
  )
}

function Header({ state }: { state: PopupState }) {
  const { view, speech } = state
  const listening = view.kind === 'prompt' || view.kind === 'awaitRequest'
  const thinking = view.kind === 'working' || (view.kind === 'answer' && view.streaming)
  const choosing = view.kind === 'files' && view.weak && !view.copied
  const pill = listening ? 'Listening' : thinking ? 'Thinking' : choosing ? 'Pick one' : view.kind === 'problem' ? 'Needs a moment' : 'Done'
  const tone = listening ? 'listening' : thinking ? 'thinking' : choosing ? 'choose' : view.kind === 'problem' ? 'problem' : 'done'
  const canSpeak = speech.enabled && (view.kind === 'answer' || view.kind === 'files')
  return (
    <header className="head">
      <Mark />
      <span className="brand">Recall</span>
      <span className={`pill pill-${tone}`}>
        {tone === 'done' ? <span aria-hidden="true">✓</span> : tone !== 'choose' && <span className="pill-dot" aria-hidden="true" />}
        {pill}
        {listening && <Meter />}
      </span>
      <span className="spacer" />
      {canSpeak && (
        <button
          className="icon-btn"
          aria-label={speech.speaking ? 'Stop reading aloud' : 'Read aloud'}
          title={speech.speaking ? 'Stop reading aloud' : 'Read aloud'}
          onClick={() => (speech.speaking ? act({ type: 'stopSpeech' }) : replay(state))}
        >
          <SpeakerIcon off={speech.speaking} />
        </button>
      )}
      <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={() => act({ type: 'dismiss' })}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M3.5 3.5l9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </header>
  )
}

function Body({ view, showCount }: { view: PopupView; showCount: number }) {
  switch (view.kind) {
    case 'prompt':
      return <Message title={copy.promptTitle(showCount)} detail={copy.PROMPT_DETAIL} />
    case 'awaitRequest':
      return <Message title={copy.AWAIT_TITLE} detail={copy.AWAIT_DETAIL} />
    case 'working':
      return (
        <>
          <Heard text={view.heard} />
          <Message
            title={view.mode === 'question' ? copy.WORKING_QUESTION : copy.workingFile(view.query)}
            detail={view.mode === 'question' ? copy.WORKING_QUESTION_DETAIL : undefined}
          />
          <div className="busy" role="progressbar" aria-label="Working" />
        </>
      )
    case 'files':
      return <Files view={view} />
    case 'answer':
      return <Answer view={view} />
    case 'problem': {
      const c = copy.problemCopy(view.problem, view.query)
      return (
        <>
          {view.heard && <Heard text={view.heard} />}
          <Message title={c.title} detail={c.detail} />
          {c.action && (
            <div className="actions">
              <button className="btn" onClick={() => act({ type: c.action!.type })}>
                {c.action.label}
              </button>
            </div>
          )}
        </>
      )
    }
  }
}

function Files({ view }: { view: Extract<PopupView, { kind: 'files' }> }) {
  const chosen = view.items[view.selected]
  const pickFirst = view.weak && !view.copied
  const others = view.items.map((item, i) => ({ item, i })).filter(({ i }) => pickFirst || i !== view.selected)
  if (pickFirst) {
    return (
      <>
        <Heard text={view.heard} />
        <Message title={copy.weakTitle(view.query)} detail={copy.WEAK_DETAIL} />
        <ul className="others weak">
          {others.map(({ item, i }) => (
            <OtherItem key={i} item={item} index={i} />
          ))}
        </ul>
        <div className="actions">
          <button className="btn" onClick={() => act({ type: 'openInRecall' })}>
            Open in Recall
          </button>
        </div>
        <p className="foot">Say “the first one” · Esc to close</p>
      </>
    )
  }
  return (
    <>
      <Heard text={view.heard} />
      <div className="hit">
        <ItemIcon item={chosen} />
        <div className="hit-text">
          <div className="hit-name" title={chosen.name}>
            {chosen.name}
          </div>
          <div className="hit-dir" title={chosen.dir}>
            {copy.middleEllipsis(chosen.dir)}
          </div>
        </div>
        {view.copied && (
          <span className="chip-ok" key={view.selected}>
            ✓ {copy.COPIED}
          </span>
        )}
      </div>
      {view.selected > 0 && <p className="note">{copy.pickedOther(view.selected)}</p>}
      <p className="detail">
        Paste it in File Explorer: <kbd>Ctrl+L</kbd>, then <kbd>Ctrl+V</kbd> and <kbd>Enter</kbd>.
      </p>
      <div className="actions">
        <button className="btn btn-primary" onClick={() => act({ type: 'reveal' })}>
          Show in folder
        </button>
        <button className="btn" onClick={() => act({ type: 'openInRecall' })}>
          Open in Recall
        </button>
      </div>
      {others.length > 0 && (
        <>
          <div className="divider" />
          <div className="sub">{copy.NOT_THIS_ONE}</div>
          <ul className="others">
            {others.map(({ item, i }) => (
              <OtherItem key={i} item={item} index={i} />
            ))}
          </ul>
        </>
      )}
      <p className="foot">{copy.filesHint(view.items.length)}</p>
      {view.indexing && <p className="foot">{copy.INDEXING_NOTE}</p>}
    </>
  )
}

function OtherItem({ item, index }: { item: PopupItem; index: number }) {
  return (
    <li>
      <button className="other" onClick={() => act({ type: 'select', index })} title={`Copy this path (${item.dir})`}>
        <span className="num" aria-hidden="true">
          {index + 1}
        </span>
        <ItemIcon item={item} />
        <span className="other-name">{item.name}</span>
        <span className="other-dir">{copy.middleEllipsis(item.dir, 1)}</span>
      </button>
    </li>
  )
}

function Answer({ view }: { view: Extract<PopupView, { kind: 'answer' }> }) {
  const [more, setMore] = useState(false)
  const [long, setLong] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)
  useLayoutEffect(() => {
    const el = textRef.current
    if (el && !more) setLong(el.scrollHeight > el.clientHeight + 2)
  }, [view.text, more])
  return (
    <>
      <Heard text={view.heard} />
      <p ref={textRef} className={`answer ${more ? '' : 'clamped'}`}>
        <Cited text={view.text} />
        {view.streaming && <span className="caret" aria-hidden="true" />}
      </p>
      {long && !more && (
        <button className="link" onClick={() => setMore(true)}>
          Show more
        </button>
      )}
      {view.sources.length > 0 && (
        <>
          <div className="sub">Sources</div>
          <ul className="others">
            {view.sources.map((s) => (
              <Source key={s.n} s={s} />
            ))}
          </ul>
        </>
      )}
      {view.indexing && <p className="foot">{copy.INDEXING_NOTE}</p>}
    </>
  )
}

function Source({ s }: { s: PopupSource }) {
  const ext = s.name.split('.').pop()?.toLowerCase() ?? ''
  return (
    <li>
      <button className="other" onClick={() => act({ type: 'openSource', fileId: s.fileId })} title="Open this file">
        <span className="num" aria-hidden="true">
          {s.n}
        </span>
        <FileBadge ext={ext} />
        <span className="other-name">{s.name}</span>
        {s.location && <span className="other-dir">{s.location}</span>}
      </button>
    </li>
  )
}

/** Answer text with "[2]" citations as small chips; text nodes only, never HTML. */
function Cited({ text }: { text: string }) {
  const parts: ReactNode[] = []
  const re = /\[(\d+)\]/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(
      <span key={m.index} className="cite" aria-label={`source ${m[1]}`}>
        {m[1]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

function Message({ title, detail }: { title: string; detail?: string }) {
  return (
    <>
      <p className="title">{title}</p>
      {detail && <p className="detail">{detail}</p>}
    </>
  )
}

function Heard({ text }: { text: string }) {
  return <p className="heard">{copy.quoted(text, 60)}</p>
}

function ItemIcon({ item }: { item: PopupItem }) {
  if (!item.isFolder) return <FileBadge ext={item.ext} />
  return (
    <svg className="folder-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
      <path d="M3 5a1 1 0 0 1 1-1h6l2 2h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5Z" />
    </svg>
  )
}

/** A 5-bar meter driven by the real mic level, so it shows Recall is actually hearing something. */
function Meter() {
  const [level, setLevel] = useState(0)
  useEffect(() => api().onLevel((rms) => setLevel((l) => Math.max(rms, l * 0.6))), [])
  const n = Math.min(5, Math.round(Math.sqrt(level / 0.08) * 5))
  return (
    <span className="meter" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={i < n ? 'on' : ''} style={{ height: `${4 + i * 2}px` }} />
      ))}
    </span>
  )
}

function Mark() {
  return (
    <svg className="logo" viewBox="0 0 64 64" width="20" height="20" aria-hidden="true">
      <rect className="logo-tile" width="64" height="64" rx="16" />
      <path className="logo-folder" d="M14 22a4 4 0 0 1 4-4h9l4 4h15a4 4 0 0 1 4 4v16a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4Z" />
      <circle className="logo-lens" cx="30" cy="31" r="6" />
      <path className="logo-lens" d="M34.5 35.5 39 40" />
    </svg>
  )
}

function SpeakerIcon({ off }: { off: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M4 9h4l5-4v14l-5-4H4V9Z" />
      {off ? (
        <path d="M16 9l5 5m0-5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : (
        <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  )
}

/** What to say for this state, or nothing. The prompt itself is never spoken (D-23). */
function spokenText(view: PopupView): string | undefined {
  switch (view.kind) {
    case 'files': {
      const item = view.items[view.selected]
      if (!view.copied) return view.weak ? copy.SPOKEN_WEAK : undefined
      return copy.spokenCopied(item.name, item.isFolder, view.selected || undefined)
    }
    case 'answer':
      return view.streaming ? undefined : copy.spokenAnswer(view.text)
    case 'problem':
      return copy.problemCopy(view.problem, view.query).spoken
    default:
      return undefined
  }
}

function replay(state: PopupState): void {
  const text = spokenText(state.view)
  if (!text) return
  void speak(text, () => act({ type: 'speaking', on: true })).then(() => act({ type: 'speaking', on: false }))
}

/** Speaks each new result once, when read-aloud is on. */
function useSpokenReply(state: PopupState | undefined): void {
  const said = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!state) return
    const text = spokenText(state.view)
    const key = `${state.showCount}:${text}`
    if (!state.speech.enabled || !text || said.current === key) return
    said.current = key
    void speak(text, () => act({ type: 'speaking', on: true })).then(() => act({ type: 'speaking', on: false }))
  }, [state])
  useEffect(() => {
    if (state && !state.speech.speaking && state.view.kind === 'prompt') stopSpeaking()
  }, [state?.view.kind])
  // Main asks to stop (Esc, "stop", the speaker button): it clears speaking, which ends the utterance.
  const wasSpeaking = useRef(false)
  useEffect(() => {
    if (wasSpeaking.current && state && !state.speech.speaking) stopSpeaking()
    wasSpeaking.current = !!state?.speech.speaking
  }, [state?.speech.speaking])
}
