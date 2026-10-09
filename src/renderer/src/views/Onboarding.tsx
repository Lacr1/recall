import { useEffect, useRef, useState } from 'react'
import type { AppStatus, FolderSuggestion, SuggestedFolderId } from '../../../shared/types'
import { Icon, Logo, type IconName } from '../components'
import { AiPanel } from './AiPanel'
import { plural, shortDir } from '../format'

const STEPS = [
  { label: 'Welcome', hint: 'What Recall does' },
  { label: 'Local AI', hint: 'Optional smart search' },
  { label: 'Folders', hint: 'What to remember' },
  { label: 'Ready', hint: 'Start searching' }
]

const PROMISES: { icon: IconName; title: string; text: string }[] = [
  { icon: 'laptop', title: 'Runs on this computer', text: 'Searching happens on your PC. No account, nothing uploaded.' },
  { icon: 'folder', title: 'Only folders you choose', text: 'Recall reads the folders you pick and nothing else. Remove one any time.' },
  { icon: 'shield', title: 'Never changes your files', text: 'Recall only reads. It never moves, edits or deletes anything.' },
  { icon: 'lock', title: 'Private and offline', text: 'Once set up, Recall needs no internet connection.' }
]

const SHORTCUTS: [string, string][] = [
  ['Ctrl + K', 'Jump to the search box'],
  ['↑ ↓', 'Move between results'],
  ['Enter', 'Open the selected file'],
  ['Ctrl + Enter', 'Show the file in its folder'],
  ['Ctrl + ,', 'Open Settings']
]

/** Windows paths are case-insensitive; matches the engine's pathKey without needing Node's path module. */
const folderKey = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()

function Stepper({ step, onBack }: { step: number; onBack: (n: number) => void }) {
  return (
    <nav aria-label="Setup steps">
      <ol className="stepper">
        {STEPS.map((s, i) => {
          const n = i + 1
          const state = n < step ? 'done' : n === step ? 'current' : 'todo'
          const body = (
            <>
              <span className="step-num" aria-hidden="true">{state === 'done' ? '✓' : n}</span>
              <span className="step-text">
                <span className="step-label">{s.label}</span>
                <span className="step-hint">{s.hint}</span>
              </span>
              <span className="visually-hidden">
                {state === 'done' ? ' (completed, go back)' : state === 'current' ? ' (current step)' : ''}
              </span>
            </>
          )
          return (
            <li key={s.label} className={`step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              {state === 'done' ? (
                <button className="step-body" onClick={() => onBack(n)}>{body}</button>
              ) : (
                <div className="step-body">{body}</div>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export function Onboarding({ status, onDone }: { status: AppStatus; onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string>()
  const [suggestions, setSuggestions] = useState<FolderSuggestion[]>([])
  // Suggestion id or folder id being added or removed; other folder buttons wait for it.
  const [pending, setPending] = useState<string>()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const firstRender = useRef(true)

  // Move focus to the new step's heading so screen readers announce it.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    headingRef.current?.focus()
  }, [step])

  useEffect(() => {
    window.recall.getFolderSuggestions().then(setSuggestions, () => setSuggestions([]))
  }, [])

  const addFolder = async () => {
    setError(undefined)
    const r = await window.recall.addFolder()
    if (r.error) setError(r.error)
  }

  const run = async (key: string, action: () => Promise<{ error?: string } | void>) => {
    setError(undefined)
    setPending(key)
    try {
      const r = await action()
      if (r?.error) setError(r.error)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setPending(undefined)
    }
  }
  const addSuggested = (id: SuggestedFolderId) => run(id, () => window.recall.addSuggestedFolder(id))
  // Onboarding folders were just added, so removing needs no confirmation; files on disk are never touched.
  const removeFolder = (id: number) => run(String(id), () => window.recall.removeFolder(id))

  const exactFolder = (p: string) => status.folders.find((f) => folderKey(f.path) === folderKey(p))
  const insideFolder = (p: string) => status.folders.some((f) => folderKey(p).startsWith(folderKey(f.path) + '\\'))

  const aiReady = status.ai.state === 'ready'
  const { progress } = status
  const pct = (done: number, total: number) => (total > 0 ? Math.round((done / total) * 100) : 0)
  const readPct = pct(progress.readDone, progress.readTotal)
  const embedPct = pct(progress.embedDone, progress.embedTotal)

  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <Stepper step={step} onBack={setStep} />

        {step === 1 && (
          <div className="onboarding-step" key="1">
            <div className="hero">
              <Logo size={56} />
              <div>
                <h1 className="hero-title" ref={headingRef} tabIndex={-1}>Welcome to Recall</h1>
                <p className="hero-sub">Your computer should remember what you forgot.</p>
              </div>
            </div>
            <p className="lead">
              Recall finds files from what you remember about them: a phrase, a topic, or roughly what was inside. Not just the file name.
            </p>
            <ul className="promise-grid">
              {PROMISES.map((p) => (
                <li key={p.title} className="promise">
                  <span className="promise-icon"><Icon name={p.icon} /></span>
                  <span>
                    <span className="promise-title">{p.title}</span>
                    <span className="promise-text">{p.text}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="hint">Setup takes about two minutes: turn on local AI (optional), then choose the folders to remember.</p>
            <div className="onboarding-actions">
              <span className="spacer" />
              <button className="btn btn-primary btn-lg" autoFocus onClick={() => setStep(2)}>
                Get started
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-step" key="2">
            <h1 ref={headingRef} tabIndex={-1}>Turn on smart search</h1>
            <p className="lead">
              With local AI, Recall searches by meaning. “Contract with a deposit” can find a file that says “agreement requiring 50%
              upfront”. It uses Ollama, a free app that runs AI on this computer, so your files still never leave it.
            </p>
            <div className="compare">
              <div className="compare-col">
                <div className="compare-title">With local AI</div>
                <ul>
                  <li>Search by meaning and by keywords</li>
                  <li>Ask questions about your files (with the optional answer model)</li>
                </ul>
              </div>
              <div className="compare-col">
                <div className="compare-title">Without it</div>
                <ul>
                  <li>Search by exact words and file names</li>
                  <li>Turn on local AI later in Settings</li>
                </ul>
              </div>
            </div>
            <AiPanel status={status} />
            <p className="hint">The search model is a one-time download of about 274 MB. After that, everything works offline.</p>
            <div className="onboarding-actions">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <span className="spacer" />
              {!aiReady && (
                <button className="btn" onClick={() => setStep(3)}>Skip for now</button>
              )}
              <button className="btn btn-primary" disabled={!aiReady} onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="onboarding-step" key="3">
            <h1 ref={headingRef} tabIndex={-1}>Choose folders to remember</h1>
            <p className="lead">Recall will only read these folders. You can add or remove folders later from the Folders page.</p>
            {suggestions.length > 0 && (
              <div>
                <div className="section-label" id="suggested-label">Suggested folders</div>
                <ul className="suggest-grid" aria-labelledby="suggested-label">
                  {suggestions.map((s) => {
                    const folder = exactFolder(s.path)
                    // Covered by a parent folder: shown as added, removed via that parent.
                    const viaParent = !folder && insideFolder(s.path)
                    const added = !!folder || viaParent
                    return (
                      <li key={s.id}>
                        <button
                          className={`suggest ${added ? 'added' : ''}`}
                          disabled={viaParent || pending !== undefined}
                          aria-pressed={added}
                          title={folder ? `Click to remove ${s.label}` : viaParent ? 'Included in a folder you added' : undefined}
                          onClick={() => void (folder ? removeFolder(folder.id) : addSuggested(s.id))}
                        >
                          <span className="promise-icon"><Icon name="folder" /></span>
                          <span className="suggest-text">
                            <span className="promise-title">{s.label}</span>
                            <span className="suggest-path" title={s.path}>{shortDir(s.path)}</span>
                          </span>
                          <span className="suggest-action" aria-hidden="true">
                            {pending === s.id || (folder && pending === String(folder.id)) ? (
                              '…'
                            ) : added ? (
                              <>
                                <span className="when-idle">✓</span>
                                <span className="when-hover">×</span>
                              </>
                            ) : (
                              '+'
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
            <div>
              <button className="btn" onClick={addFolder}>{suggestions.length > 0 ? 'Choose another folder…' : 'Choose a folder…'}</button>
            </div>
            {error && <p className="error" role="alert">{error}</p>}
            <div>
              <div className="section-label" id="chosen-label">Your folders</div>
              <ul className="folder-pick-list" aria-labelledby="chosen-label">
                {status.folders.length === 0 && <li className="muted">No folders yet. Add at least one to continue.</li>}
                {status.folders.map((f) => (
                  <li key={f.id}>
                    <span className="mono folder-pick-path">{f.path}</span>
                    <span className="muted">{f.fileCount ? plural(f.fileCount, 'file') : 'counting…'}</span>
                    <button
                      className="btn btn-sm btn-danger-outline"
                      disabled={pending !== undefined}
                      aria-label={`Remove ${f.path}`}
                      onClick={() => void removeFolder(f.id)}
                    >
                      {pending === String(f.id) ? 'Removing…' : 'Remove'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <p className="hint">
              Recall reads text, Markdown, PDF, Word (.docx) and code files. It skips hidden files, system folders and build folders like
              node_modules.
            </p>
            <div className="onboarding-actions">
              <button className="btn" onClick={() => setStep(2)}>Back</button>
              <span className="spacer" />
              <button className="btn btn-primary" disabled={status.folders.length === 0} onClick={() => setStep(4)}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="onboarding-step" key="4">
            <h1 ref={headingRef} tabIndex={-1}>You're all set</h1>
            <p className="lead">
              Recall is reading your files in the background. You can search right away; results get better as it finishes.
            </p>
            <div className="card ready-progress">
              <div className="ready-row">
                <span>
                  {progress.readTotal === 0
                    ? 'Looking for files…'
                    : `Reading files: ${progress.readDone.toLocaleString()} of ${progress.readTotal.toLocaleString()}`}
                </span>
                <span className="muted small">{aiReady ? 'Search by meaning is on' : 'Keyword search only'}</span>
              </div>
              <div className="progress" role="progressbar" aria-label="Reading files" aria-valuemin={0} aria-valuemax={100} aria-valuenow={readPct}>
                <div className="progress-fill" style={{ width: `${readPct}%` }} />
              </div>
              {aiReady && progress.embedTotal > 0 && (
                <>
                  <div className="ready-row">
                    <span>Understanding meaning: {progress.embedDone.toLocaleString()} of {progress.embedTotal.toLocaleString()}</span>
                  </div>
                  <div className="progress" role="progressbar" aria-label="Understanding meaning" aria-valuemin={0} aria-valuemax={100} aria-valuenow={embedPct}>
                    <div className="progress-fill" style={{ width: `${embedPct}%` }} />
                  </div>
                </>
              )}
            </div>
            <div className="ready-grid">
              <div>
                <div className="section-label">Tips for searching</div>
                <ul className="tips">
                  <li>Describe it in your own words, like “invoice from the Lisbon trip”.</li>
                  <li>Use a phrase you remember from inside the file.</li>
                  <li>Part of a file name works too.</li>
                </ul>
              </div>
              <div>
                <div className="section-label">Keyboard shortcuts</div>
                <dl className="shortcuts">
                  {SHORTCUTS.map(([keys, what]) => (
                    <div key={keys}>
                      <dt><kbd>{keys}</kbd></dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
            <div className="onboarding-actions">
              <button className="btn" onClick={() => setStep(3)}>Back</button>
              <span className="spacer" />
              <button className="btn btn-primary btn-lg" onClick={onDone}>
                Start searching
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
