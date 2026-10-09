import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { ConfirmDialog } from '../components'
import { formatBytes } from '../format'
import { AiPanel } from './AiPanel'

export function SettingsView({ status }: { status: AppStatus }) {
  const [info, setInfo] = useState<{ path: string; bytes: number }>()
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    void window.recall.getDataInfo().then(setInfo)
  }, [status.progress.chunks, status.folders.length])

  const deleteAll = async () => {
    setConfirm(false)
    await window.recall.deleteAllData()
    try {
      localStorage.clear()
    } catch {
      // Nothing stored.
    }
    location.reload()
  }

  return (
    <div className="settings-view">
      <h1 className="view-title">Settings</h1>

      <section className="card">
        <h2 className="card-title">Local AI</h2>
        <AiPanel status={status} />
      </section>

      <section className="card">
        <h2 className="card-title">Privacy &amp; data</h2>
        <ul className="facts">
          <li>Recall only connects to Ollama on this computer (127.0.0.1). It has no accounts, telemetry, or cloud services.</li>
          <li>Recall reads your files but never changes, moves, or deletes them.</li>
          <li>Its index (extracted text and search vectors) is stored unencrypted in your Windows profile, protected by your account.</li>
          <li>Logs never contain document text or your searches.</li>
        </ul>
        <div className="data-row">
          <div>
            <div className="small muted">Index location</div>
            <div className="mono small break">{info?.path ?? '…'}</div>
          </div>
          <div>
            <div className="small muted">Size</div>
            <div>{info ? formatBytes(info.bytes) : '…'}</div>
          </div>
        </div>
        <button className="btn btn-danger-outline" onClick={() => { setTyped(''); setConfirm(true) }}>Delete all Recall data…</button>
      </section>

      <section className="card">
        <h2 className="card-title">About</h2>
        <p className="small muted">
          Recall 0.1 (hackathon build). Search model: {status.ai.embedModel}. Answer model: {status.ai.chatModel}.
        </p>
      </section>

      {confirm && (
        <ConfirmDialog
          title="Delete all Recall data?"
          body={
            <p>
              This removes Recall’s index, settings and logs. <strong>Your files and your Ollama models are not touched.</strong> You’ll
              start again from setup.
            </p>
          }
          confirmLabel="Delete everything"
          danger
          requireText="DELETE"
          value={typed}
          onValue={setTyped}
          onCancel={() => setConfirm(false)}
          onConfirm={() => void deleteAll()}
        />
      )}
    </div>
  )
}
