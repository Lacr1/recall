import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { ConfirmDialog } from '../components'
import { formatBytes } from '../format'

/** Ollama + model readiness rows with the actions each state allows. */
export function AiPanel({ status }: { status: AppStatus }) {
  const { ai } = status
  const [confirmPull, setConfirmPull] = useState(false)
  const [message, setMessage] = useState<string>()

  const ollamaRow = () => {
    switch (ai.state) {
      case 'not_installed':
        return { text: 'Not installed', ok: false }
      case 'not_running':
        return { text: 'Installed, not running', ok: false }
      case 'checking':
        return { text: 'Checking…', ok: false }
      default:
        return { text: `Running${ai.ollamaVersion ? ` (v${ai.ollamaVersion})` : ''}`, ok: true }
    }
  }
  const o = ollamaRow()
  const modelReady = ai.state === 'ready'
  const pct = ai.pull && ai.pull.total > 0 ? Math.round((ai.pull.completed / ai.pull.total) * 100) : undefined

  return (
    <div className="ai-panel">
      <div className="ai-row">
        <div>
          <div className="ai-row-title">Ollama</div>
          <div className="ai-row-sub">Free app that runs AI models on this computer</div>
        </div>
        <div className={`ai-state ${o.ok ? 'ok' : 'warn'}`}>{o.ok ? '● ' : '○ '}{o.text}</div>
        <div className="ai-actions">
          {ai.state === 'not_running' && (
            <button
              className="btn btn-primary"
              onClick={async () => {
                const r = await window.recall.startOllama()
                setMessage(r.ok ? 'Starting Ollama…' : r.message)
              }}
            >
              Start Ollama
            </button>
          )}
          {ai.state === 'not_installed' && (
            <button className="btn" onClick={() => window.recall.openOllamaDownload()}>
              Get Ollama (opens browser)
            </button>
          )}
        </div>
      </div>

      <div className="ai-row">
        <div>
          <div className="ai-row-title">Search model</div>
          <div className="ai-row-sub">{ai.embedModel} · lets Recall search by meaning</div>
        </div>
        <div className={`ai-state ${modelReady ? 'ok' : 'warn'}`}>
          {modelReady ? '● Ready' : ai.state === 'pulling' ? `Downloading${pct !== undefined ? ` ${pct}%` : '…'}` : ai.state === 'model_missing' ? '○ Not downloaded' : '○ Needs Ollama'}
        </div>
        <div className="ai-actions">
          {ai.state === 'model_missing' && (
            <button className="btn btn-primary" onClick={() => setConfirmPull(true)}>
              Download…
            </button>
          )}
        </div>
      </div>
      {ai.state === 'pulling' && ai.pull && (
        <div className="progress" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
          <div className="progress-fill" style={{ width: `${pct ?? 0}%` }} />
          <span className="progress-text">
            {ai.pull.status}
            {ai.pull.total > 0 && ` · ${formatBytes(ai.pull.completed)} of ${formatBytes(ai.pull.total)}`}
          </span>
        </div>
      )}

      <div className="ai-row">
        <div>
          <div className="ai-row-title">Answer model (optional)</div>
          <div className="ai-row-sub">{ai.chatModel} · used by Ask your files</div>
        </div>
        <div className={`ai-state ${ai.chatAvailable ? 'ok' : 'muted'}`}>{ai.chatAvailable ? '● Ready' : '○ Not installed'}</div>
        <div className="ai-actions" />
      </div>

      {(message || ai.error) && <p className="hint" role="status">{ai.error ?? message}</p>}

      {confirmPull && (
        <ConfirmDialog
          title="Download the search model?"
          body={
            <p>
              Ollama will download <strong>{ai.embedModel}</strong> (about 274 MB) from the internet. This happens once; afterwards
              Recall works fully offline.
            </p>
          }
          confirmLabel="Download"
          onCancel={() => setConfirmPull(false)}
          onConfirm={() => {
            setConfirmPull(false)
            void window.recall.pullModel()
          }}
        />
      )}
    </div>
  )
}
