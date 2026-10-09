import { useEffect, useState } from 'react'
import type { AppStatus, FailureItem, FolderInfo } from '../../../shared/types'
import { ConfirmDialog } from '../components'
import { plural } from '../format'
import { indexingLabel } from './StatusBar'

const FAILURES_PAGE = 10

export function FoldersView({ status }: { status: AppStatus }) {
  const [failures, setFailures] = useState<FailureItem[]>([])
  const [removing, setRemoving] = useState<FolderInfo>()
  const [error, setError] = useState<string>()
  const [failuresShown, setFailuresShown] = useState(FAILURES_PAGE)
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
        <p className="small muted index-hint">{indexHint(status)}</p>
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
        <IndexHelp />
      </section>

      {status.folders.length === 0 && <p className="muted">No folders yet. Add a folder you’d like Recall to remember.</p>}
      {status.folders.length > 0 && (
        <div className="folder-grid">
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
        </div>
      )}

      <section className="card">
        <div className="view-header">
          <h2 className="card-title">Skipped &amp; failed files</h2>
          <span className="spacer" />
          {failures.length > 0 && <button className="btn" onClick={() => void window.recall.retryFailed()}>Retry all</button>}
        </div>
        <p className="small muted">
          Files Recall couldn’t read, and why. They stay on your computer unchanged; they just won’t show up in search or answers.
          Retry all tries them again, for example after you’ve repaired or replaced a file.
        </p>
        {failures.length === 0 ? (
          <p className="muted small">Nothing to report.</p>
        ) : (
          <>
            <ul className="failures">
              {failures.slice(0, failuresShown).map((f) => (
                <li key={f.fileId}>
                  <span className="failure-name" title={f.path}>{f.name}</span>
                  <span className="muted small">{f.reason}</span>
                </li>
              ))}
            </ul>
            {failures.length > failuresShown && (
              <div className="failures-more">
                <span className="muted small">Showing {failuresShown.toLocaleString()} of {failures.length.toLocaleString()}</span>
                <button className="btn btn-sm" onClick={() => setFailuresShown((n) => n + FAILURES_PAGE)}>Load more</button>
              </div>
            )}
          </>
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

/** One sentence on what indexing is doing right now and what that means for search. */
function indexHint(s: AppStatus): string {
  const p = s.progress
  if (s.folders.length === 0) return 'Add a folder to start building the index.'
  if (p.paused) return 'Indexing is paused. Recall won’t read or understand anything new until you resume.'
  if (p.filesPending > 0 || p.readDone < p.readTotal || p.scanning)
    return 'Recall is reading your files. Each one can be found by its words as soon as it’s read.'
  if (p.embedDone < p.embedTotal) {
    if (s.ai.state !== 'ready') return 'Understanding is waiting for local AI. Search uses keywords only until it’s running again.'
    return 'Every file is read, so keyword search already covers them all. Recall is now understanding them, which takes longer.'
  }
  return 'Everything is read and understood. Recall picks up new and changed files on its own.'
}

function IndexHelp() {
  return (
    <details className="index-help">
      <summary>What do these mean, and how can I speed things up?</summary>
      <div className="index-help-grid">
        <div>
          <h3 className="index-help-title">Index status</h3>
          <p>
            The index is Recall’s private catalog of your files, kept on this computer. Recall builds it in two steps, reading
            then understanding, and keeps it up to date as files are added, changed or deleted.
          </p>
        </div>
        <div>
          <h3 className="index-help-title">Reading files</h3>
          <p>
            Recall opens each file and pulls out its text. As soon as a file is read, you can find it by the words inside it.
            Files with no readable text, like scanned images, are listed under Skipped &amp; failed files.
          </p>
        </div>
        <div>
          <h3 className="index-help-title">Understanding</h3>
          <p>
            The local AI works out what each passage means, so you can search by meaning and Reca can answer questions. It’s
            slower than reading and starts once a file is read. A file counts only when all its passages are done, so the
            number can sit still while a big file is worked on.
          </p>
        </div>
      </div>
      <h3 className="index-help-title">Making Understanding go faster</h3>
      <ul className="tips">
        <li>Keep Recall open. It works in the background and carries on where it left off after a restart.</li>
        <li>Keep local AI running. The status bar should say “Local AI ready”; without it, Understanding waits.</li>
        <li>Make sure indexing isn’t paused. If it is, press Resume indexing above.</li>
        <li>Give your computer a break. The local AI uses its processor, so it goes faster with heavy apps closed.</li>
        <li>Index only what you need. Removing big folders you don’t search, like Downloads, leaves less to understand.</li>
      </ul>
    </details>
  )
}
