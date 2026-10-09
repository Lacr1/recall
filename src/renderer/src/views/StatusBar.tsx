import type { AppStatus } from '../../../shared/types'
import type { View } from '../App'
import { plural } from '../format'

export function indexingLabel(s: AppStatus): { text: string; busy: boolean } {
  const p = s.progress
  if (p.paused) return { text: 'Indexing paused', busy: false }
  const reading = p.filesPending > 0 || p.readDone < p.readTotal || p.scanning
  const understanding = s.ai.state === 'ready' && p.embedDone < p.embedTotal
  if (reading) return { text: `Reading files ${p.readDone.toLocaleString()} / ${p.readTotal.toLocaleString()}`, busy: true }
  if (understanding) return { text: `Understanding ${p.embedDone.toLocaleString()} / ${p.embedTotal.toLocaleString()}`, busy: true }
  return { text: `${plural(p.filesTotal, 'file')} indexed`, busy: false }
}

export function aiLabel(s: AppStatus): { text: string; ok: boolean } {
  switch (s.ai.state) {
    case 'ready':
      return { text: 'Local AI ready', ok: true }
    case 'checking':
      return { text: 'Checking local AI…', ok: false }
    case 'pulling':
      return { text: 'Downloading search model…', ok: false }
    case 'model_missing':
      return { text: 'Keyword-only (search model missing)', ok: false }
    case 'not_running':
      return { text: 'Keyword-only (Ollama not running)', ok: false }
    case 'not_installed':
      return { text: 'Keyword-only (Ollama not installed)', ok: false }
  }
}

export function StatusBar({ status, onNavigate }: { status: AppStatus; onNavigate: (v: View) => void }) {
  const idx = indexingLabel(status)
  const ai = aiLabel(status)
  return (
    <footer className="statusbar">
      <button className="status-item" onClick={() => onNavigate('folders')}>
        <span className={`dot ${idx.busy ? 'dot-busy' : 'dot-ok'}`} aria-hidden="true" />
        {idx.text}
      </button>
      <button className="status-item" onClick={() => onNavigate('settings')}>
        <span className={`dot ${ai.ok ? 'dot-ok' : 'dot-warn'}`} aria-hidden="true" />
        {ai.text}
      </button>
      <span className="status-item muted">Runs on this computer · no cloud</span>
    </footer>
  )
}
