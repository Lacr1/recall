import { useEffect, useState } from 'react'
import type { AppStatus, AskEvent } from '../../shared/types'
import { Icon } from './components'
import { Onboarding } from './views/Onboarding'
import { SearchView } from './views/SearchView'
import { AskView } from './views/AskView'
import { FoldersView } from './views/FoldersView'
import { SettingsView } from './views/SettingsView'
import { StatusBar } from './views/StatusBar'

export type View = 'search' | 'ask' | 'folders' | 'settings'

const ONBOARDED_KEY = 'recall.onboarded'

function readOnboarded(): boolean {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    return false
  }
}

export function App() {
  const [status, setStatus] = useState<AppStatus>()
  const [view, setView] = useState<View>('search')
  const [onboarded, setOnboarded] = useState(readOnboarded)
  const [showOnboarding, setShowOnboarding] = useState<boolean>()
  const [askListeners] = useState(() => new Set<(e: AskEvent) => void>())
  const [engineNotice, setEngineNotice] = useState(false)

  useEffect(() => {
    const off = window.recall.onEvent((msg) => {
      if (msg.event === 'status') setStatus(msg.data)
      else if (msg.event === 'ask') askListeners.forEach((l) => l(msg.data))
      else if (msg.event === 'engineRestarted') {
        setEngineNotice(true)
        void window.recall.getStatus().then(setStatus)
      }
    })
    const load = () => window.recall.getStatus().then(setStatus).catch(() => setTimeout(load, 500))
    load()
    return off
  }, [askListeners])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === ',') {
        e.preventDefault()
        setView('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!status) return <div className="splash">Starting Recall…</div>

  const finishOnboarding = () => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1')
    } catch {
      // Storage unavailable: onboarding will show again next launch.
    }
    setOnboarded(true)
    setShowOnboarding(false)
    setView('search')
  }

  // Decided once on first status so adding a folder mid-onboarding doesn't skip the last step.
  if (showOnboarding === undefined) {
    setShowOnboarding(!onboarded && status.folders.length === 0)
    return null
  }
  if (showOnboarding) {
    return <Onboarding status={status} onDone={finishOnboarding} />
  }

  const nav: { id: View; label: string; icon: 'search' | 'ask' | 'folder' | 'settings' }[] = [
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'ask', label: 'Ask', icon: 'ask' },
    { id: 'folders', label: 'Folders', icon: 'folder' },
    { id: 'settings', label: 'Settings', icon: 'settings' }
  ]

  return (
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="brand" aria-hidden="true">R</div>
        {nav.map((n) => (
          <button
            key={n.id}
            className={`rail-item ${view === n.id ? 'active' : ''}`}
            aria-current={view === n.id ? 'page' : undefined}
            onClick={() => setView(n.id)}
          >
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </button>
        ))}
      </nav>
      <main className="content">
        {engineNotice && (
          <div className="banner banner-info" role="status">
            Recall's indexer restarted after a problem. No data was lost.
            <button className="link" onClick={() => setEngineNotice(false)}>Dismiss</button>
          </div>
        )}
        {view === 'search' && <SearchView status={status} onNavigate={setView} />}
        {view === 'ask' && <AskView status={status} listeners={askListeners} onNavigate={setView} />}
        {view === 'folders' && <FoldersView status={status} />}
        {view === 'settings' && <SettingsView status={status} />}
      </main>
      <StatusBar status={status} onNavigate={setView} />
    </div>
  )
}
