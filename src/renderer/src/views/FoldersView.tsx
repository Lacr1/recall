import { useEffect, useState } from 'react'
import type { AppStatus, FailureItem, FolderInfo } from '../../../shared/types'
import { ConfirmDialog } from '../components'
import { plural } from '../format'
import { indexingLabel } from './StatusBar'

export function FoldersView({ status }: { status: AppStatus }) {
  const [failures, setFailures] = useState<FailureItem[]>([])
  const [removing, setRemoving] = useState<FolderInfo>()
  const [error, setError] = useState<string>()
  const p = status.progress
  const idx = indexingLabel(status)

  const failureKey = p.failed + p.skipped
  useEffect(() => {
    void window.recall.listFailures().then(setFailures)
  }, [failureKey, status.folders.length])

  const add = async () => {
    setError(undefined)
    const r = await window.recall.addFolder()
    if (r.error) setError(r.error)
  }

  const readPct = p.readTotal ? Math.round((p.readDone / p.readTotal) * 100) : 0
  const embedPct = p.embedTotal ? Math.round((p.embedDone / p.embedTotal) * 100) : 0

  return (
    <div className="folders-view">
      <div className="view-header">
        <h1 className="view-title">Folders</h1>
        <span className="spacer" />
        <button className="btn" onClick={() => void window.recall.setPaused(!p.paused)}>{p.paused ? 'Resume indexing' : 'Pause indexing'}</button>
        <button className="btn btn-primary" onClick={add}>+ Add folder</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      <section className="card">
        <h2 className="card-title">Index status: {idx.text}</h2>
        <div className="bar-row">
          <span>Reading files</span>
          <div className="progress small-bar" role="progressbar" aria-label="Reading files" aria-valuenow={readPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${readPct}%` }} />
          </div>
          <span className="muted">{p.readDone.toLocaleString()} / {p.readTotal.toLocaleString()}</span>
        </div>
        <div className="bar-row">
          <span>Understanding</span>
          <div className="progress small-bar" role="progressbar" aria-label="Understanding" aria-valuenow={embedPct} aria-valuemin={0} aria-valuemax={100}>
            <div className="progress-fill" style={{ width: `${embedPct}%` }} />
          </div>
          <span className="muted">
            {status.ai.state === 'ready' ? `${p.embedDone.toLocaleString()} / ${p.embedTotal.toLocaleString()}` : 'Paused while local AI is unavailable'}
          </span>
        </div>
      </section>

      {status.folders.length === 0 && <p className="muted">No folders yet. Add a folder you’d like Recall to remember.</p>}
      {status.folders.map((f) => (
        <section key={f.id} className="card folder-card">
          <div className="folder-path mono">{f.path}</div>
          <div className="small muted">
            {plural(f.fileCount, 'file')}
            {f.status === 'unavailable' && ' · Unavailable: folder not found (index kept)'}
            {f.skippedCount > 0 && ` · ${f.skippedCount} skipped`}
            {f.failedCount > 0 && ` · ${f.failedCount} could not be read`}
          </div>
          <div className="folder-actions">
            <button className="btn" onClick={() => void window.recall.rescanFolder(f.id)}>Re-scan</button>
            <button className="btn btn-danger-outline" onClick={() => setRemoving(f)}>Remove from Recall…</button>
          </div>
        </section>
      ))}

      <section className="card">
        <div className="view-header">
          <h2 className="card-title">Skipped &amp; failed files</h2>
          <span className="spacer" />
          {failures.length > 0 && <button className="btn" onClick={() => void window.recall.retryFailed()}>Retry all</button>}
        </div>
        {failures.length === 0 ? (
          <p className="muted small">Nothing to report.</p>
        ) : (
          <ul className="failures">
            {failures.map((f) => (
              <li key={f.fileId}>
                <span className="failure-name" title={f.path}>{f.name}</span>
                <span className="muted small">{f.reason}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {removing && (
        <ConfirmDialog
          title={`Remove “${removing.path.split('\\').pop()}” from Recall?`}
          body={
            <p>
              Recall will forget everything it learned from this folder ({plural(removing.fileCount, 'file')}).{' '}
              <strong>Your files will not be changed or deleted.</strong>
            </p>
          }
          confirmLabel="Remove from Recall"
          danger
          onCancel={() => setRemoving(undefined)}
          onConfirm={() => {
            void window.recall.removeFolder(removing.id)
            setRemoving(undefined)
          }}
        />
      )}
    </div>
  )
}
