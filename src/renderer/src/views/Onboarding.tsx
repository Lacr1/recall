import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { AiPanel } from './AiPanel'
import { plural } from '../format'

export function Onboarding({ status, onDone }: { status: AppStatus; onDone: () => void }) {
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string>()

  const addFolder = async () => {
    setError(undefined)
    const r = await window.recall.addFolder()
    if (r.error) setError(r.error)
  }

  return (
    <main className="onboarding">
      <div className="onboarding-card">
        <div className="stepper" role="img" aria-label={`Step ${step} of 3`}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={`step-dot ${n <= step ? 'on' : ''}`} />
          ))}
        </div>

        {step === 1 && (
          <>
            <h1 className="hero-title">Recall</h1>
            <p className="hero-sub">Your computer should remember what you forgot.</p>
            <ul className="promises">
              <li>Runs on this computer. Your files never leave it.</li>
              <li>Only reads folders you choose.</li>
              <li>Never changes or deletes your files.</li>
              <li>Works offline once set up.</li>
            </ul>
            <div className="onboarding-actions">
              <button className="btn btn-primary btn-lg" autoFocus onClick={() => setStep(2)}>
                Get started
              </button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1>Set up local AI</h1>
            <p className="lead">Recall uses Ollama to search by meaning, entirely on this computer.</p>
            <AiPanel status={status} />
            <div className="onboarding-actions">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <span className="spacer" />
              {status.ai.state !== 'ready' && (
                <button className="btn" onClick={() => setStep(3)}>Skip — use keyword search for now</button>
              )}
              <button className="btn btn-primary" disabled={status.ai.state !== 'ready'} onClick={() => setStep(3)}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h1>Choose folders to remember</h1>
            <p className="lead">Recall will only read these folders. You can add more later.</p>
            <ul className="folder-pick-list">
              {status.folders.length === 0 && <li className="muted">No folders yet.</li>}
              {status.folders.map((f) => (
                <li key={f.id}>
                  <span className="mono">{f.path}</span>
                  <span className="muted">{f.fileCount ? plural(f.fileCount, 'file') : 'counting…'}</span>
                </li>
              ))}
            </ul>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="onboarding-actions">
              <button className="btn" onClick={() => setStep(2)}>Back</button>
              <button className="btn" onClick={addFolder}>+ Add folder…</button>
              <span className="spacer" />
              <button className="btn btn-primary" disabled={status.folders.length === 0} onClick={onDone}>
                Start searching
              </button>
            </div>
            <p className="hint">Indexing runs in the background — you can search right away and results improve as it continues.</p>
          </>
        )}
      </div>
    </main>
  )
}
