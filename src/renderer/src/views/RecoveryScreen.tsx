import { useState } from 'react'
import type { AppStatus } from '../../../shared/types'

const COPY: Record<NonNullable<AppStatus['problem']>['code'], { title: string; body: string }> = {
  damaged: {
    title: 'Recall’s index is damaged',
    body: 'Your files are safe: Recall never changes them. Rebuilding reads your folders again from scratch; for large folders this can take a while, and you can search as it goes.'
  },
  newer_version: {
    title: 'This index was made by a newer version of Recall',
    body: 'This version can’t read it. Rebuilding replaces it with a new index of the same folders. Your files are not touched.'
  },
  migration_failed: {
    title: 'Recall couldn’t update its index format',
    body: 'Your previous index was restored unchanged, but this version can’t use it. Rebuilding creates a new index of the same folders. Your files are not touched.'
  },
  cannot_open: {
    title: 'Recall can’t open its index',
    body: 'This can happen when the disk is full or the data folder can’t be written. Free some space and try again, or rebuild the index.'
  }
}

/** Full-screen notice when the index can't be used (plan doc 02 §5.13). */
export function IndexProblemScreen({ problem }: { problem: NonNullable<AppStatus['problem']> }) {
  const [busy, setBusy] = useState(false)
  const copy = COPY[problem.code]
  return (
    <main className="onboarding">
      <div className="onboarding-card" role="alertdialog" aria-labelledby="problem-title" aria-describedby="problem-body">
        <h1 id="problem-title">{copy.title}</h1>
        <p id="problem-body" className="lead">{copy.body}</p>
        {problem.code === 'cannot_open' && <p className="mono small muted break">{problem.message}</p>}
        <div className="onboarding-actions">
          {problem.code === 'cannot_open' && (
            <button className="btn" disabled={busy} onClick={() => { setBusy(true); void window.recall.restartEngine() }}>
              Try again
            </button>
          )}
          <span className="spacer" />
          <button className="btn btn-primary" autoFocus disabled={busy} onClick={() => { setBusy(true); void window.recall.rebuildIndex() }}>
            {busy ? 'Rebuilding…' : 'Rebuild index'}
          </button>
        </div>
      </div>
    </main>
  )
}

/** Shown when the indexer stopped after repeated crashes and nothing else could load. */
export function EngineStoppedScreen() {
  return (
    <main className="onboarding">
      <div className="onboarding-card" role="alertdialog" aria-labelledby="stopped-title">
        <h1 id="stopped-title">Recall’s indexer stopped</h1>
        <p className="lead">It stopped after several problems in a row. Your files are safe.</p>
        <div className="onboarding-actions">
          <span className="spacer" />
          <button className="btn btn-primary" autoFocus onClick={() => void window.recall.restartEngine()}>Restart indexer</button>
        </div>
      </div>
    </main>
  )
}
