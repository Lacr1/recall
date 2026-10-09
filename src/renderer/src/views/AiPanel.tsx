import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import nomicUrl from '../assets/nomic.png'
import ollamaUrl from '../assets/ollama.png'
import qwenUrl from '../assets/qwen.png'
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

  // S4-07: switching the search model to another one installed in Ollama.
  const [picking, setPicking] = useState(false)
  const [models, setModels] = useState<string[]>()
  const [choice, setChoice] = useState('')
  const [switching, setSwitching] = useState(false)
  const openPicker = async () => {
    setPicking(true)
    setModels(undefined)
    const list = await window.recall.listEmbedModels().catch(() => [])
    setModels(list)
    setChoice(list.find((m) => m !== ai.embedModel) ?? list[0] ?? '')
  }
  const switchModel = async () => {
    setSwitching(true)
    setMessage(undefined)
    try {
      await window.recall.setEmbedModel(choice)
      setPicking(false)
    } catch (err) {
      // Engine errors arrive as "CODE: message".
      setMessage((err as Error).message.replace(/^.*?[A-Z_]+: /, ''))
    } finally {
      setSwitching(false)
    }
  }
  const changePct = status.modelChange && status.modelChange.total > 0 ? Math.round((status.modelChange.done / status.modelChange.total) * 100) : 0

  return (
    <div className="ai-panel">
      <div className="ai-row">
        <div className="ai-name">
          <span className="ai-logo">
            <img src={ollamaUrl} alt="" width={28} height={28} draggable={false} />
          </span>
          <div>
            <div className="ai-row-title">Ollama</div>
            <div className="ai-row-sub">Free app that runs AI models on this computer</div>
          </div>
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
        <div className="ai-name">
          <span className="ai-logo">
            <img src={nomicUrl} alt="" width={22} height={22} draggable={false} />
          </span>
          <div>
            <div className="ai-row-title">Search model</div>
            <div className="ai-row-sub">{ai.embedModel} · lets Recall search by meaning</div>
          </div>
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
          {modelReady && !status.modelChange && !picking && (
            <button className="btn" onClick={() => void openPicker()}>
              Change model…
            </button>
          )}
        </div>
      </div>
      {picking && !status.modelChange && (
        <div className="model-picker">
          {models === undefined ? (
            <span className="small muted">Looking for installed models…</span>
          ) : models.length === 0 ? (
            <span className="small muted">No other models are installed in Ollama.</span>
          ) : (
            <>
              <label className="small" htmlFor="embed-model">Search with</label>
              <select id="embed-model" className="filter-select" value={choice} onChange={(e) => setChoice(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={!choice || choice === ai.embedModel || switching} onClick={() => void switchModel()}>
                {switching ? 'Checking…' : 'Switch'}
              </button>
            </>
          )}
          <button className="btn" onClick={() => setPicking(false)}>Cancel</button>
          <p className="small muted model-note">
            Recall re-reads the meaning of every file with the new model in the background. Search keeps using {ai.embedModel} until
            that finishes.
          </p>
        </div>
      )}
      {status.modelChange && (
        <div className="model-change">
          <div
            className="progress"
            role="progressbar"
            aria-label={`Switching to ${status.modelChange.model}`}
            aria-valuemin={0}
            aria-valuemax={status.modelChange.total}
            aria-valuenow={status.modelChange.done}
          >
            <div className="progress-fill" style={{ width: `${changePct}%` }} />
            <span className="progress-text">
              Switching to {status.modelChange.model} · {status.modelChange.done.toLocaleString()} of {status.modelChange.total.toLocaleString()} passages
            </span>
          </div>
          <button className="btn" onClick={() => void window.recall.cancelEmbedModelChange()}>Stop switching</button>
        </div>
      )}
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
        <div className="ai-name">
          <span className="ai-logo">
            <img src={qwenUrl} alt="" width={24} height={24} draggable={false} />
          </span>
          <div>
            <div className="ai-row-title">Answer model (optional)</div>
            <div className="ai-row-sub">{ai.chatModel} · used by Ask Reca</div>
          </div>
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
