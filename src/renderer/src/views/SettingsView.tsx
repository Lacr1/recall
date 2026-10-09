import { useEffect, useState } from 'react'
import type { AppStatus } from '../../../shared/types'
import { ConfirmDialog } from '../components'
import { formatBytes } from '../format'
import { AiPanel } from './AiPanel'
import { VoicePanel } from './VoicePanel'

export function SettingsView({ status }: { status: AppStatus }) {
  const [info, setInfo] = useState<{ path: string; bytes: number }>()
  const [confirm, setConfirm] = useState(false)
  const [typed, setTyped] = useState('')
  // Shown at once on a click; the engine's status confirms it a moment later.
  const [ocr, setOcr] = useState(!!status.ocr)
  useEffect(() => setOcr(!!status.ocr), [status.ocr])

  useEffect(() => {
    void window.recall.getDataInfo().then(setInfo)
  }, [status.progress.chunks, status.folders.length])

  // Main clears stored settings and reloads the window, which returns to onboarding.
  const deleteAll = async () => {
    setConfirm(false)
    await window.recall.deleteAllData()
  }

  return (
    <div className="settings-view">
      <h1 className="view-title">Settings</h1>

      <section className="card">
        <h2 className="card-title">Local AI</h2>
        <AiPanel status={status} />
      </section>

      <section className="card">
        <h2 className="card-title">Text in images</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={ocr}
            onChange={(e) => {
              setOcr(e.target.checked)
              void window.recall.setOcr(e.target.checked)
            }}
          />
          Read text in images and scanned PDFs (OCR)
        </label>
        <p className="small muted">
          English only. Runs on this computer and takes a few seconds per page, so a large folder of scans can take a while. While
          this is off, Recall doesn’t open images at all.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Voice</h2>
        <VoicePanel status={status} mode="settings" />
      </section>

      <section className="card">
        <h2 className="card-title">Privacy &amp; data</h2>
        <ul className="facts">
          <li>Recall only connects to Ollama on this computer (127.0.0.1). It has no accounts, telemetry, or cloud services.</li>
          <li>Recall reads your files but never changes, moves, or deletes them.</li>
          <li>Its index (extracted text and search vectors) is stored unencrypted in your Windows profile, protected by your account.</li>
          <li>Logs never contain document text or your searches.</li>
          <li>Voice listens only while it is on. Audio and what you say are never saved, logged or sent anywhere.</li>
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
        <p className="small muted">
          Voice runs on this computer with sherpa-onnx (Apache-2.0): Moonshine speech recognition by Useful Sensors (MIT), Silero VAD
          (MIT) and a wake-word model trained on LibriSpeech (Panayotov et al., CC BY 4.0).
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
