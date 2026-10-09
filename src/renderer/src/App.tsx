import { useEffect, useState } from 'react'
import type { AppStatus, AskEvent } from '../../shared/types'
import { Icon, Logo } from './components'
import { Onboarding } from './views/Onboarding'
import { Splash } from './views/Splash'
import { SearchView } from './views/SearchView'
import { AskView } from './views/AskView'
import { FoldersView } from './views/FoldersView'
import { SettingsView } from './views/SettingsView'
import { StatusBar } from './views/StatusBar'
import { EngineStoppedScreen, IndexProblemScreen } from './views/RecoveryScreen'

export type View = 'search' | 'ask' | 'folders' | 'settings'

const ONBOARDED_KEY = 'recall.onboarded'
// First-time users see the splash at least this long so it doesn't flash before onboarding.
const FIRST_RUN_SPLASH_MS = 1400

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
  const [engineStopped, setEngineStopped] = useState(false)
  const [rebuiltDismissed, setRebuiltDismissed] = useState(false)

  const [splashDone, setSplashDone] = useState(onboarded)

  useEffect(() => {
    if (splashDone) return
    const t = setTimeout(() => setSplashDone(true), FIRST_RUN_SPLASH_MS)
    return () => clearTimeout(t)
  }, [splashDone])

  useEffect(() => {
    const off = window.recall.onEvent((msg) => {
      if (msg.event === 'status') setStatus(msg.data)
      else if (msg.event === 'ask') askListeners.forEach((l) => l(msg.data))
      else if (msg.event === 'engineRestarted') {
        setEngineNotice(true)
        setEngineStopped(false)
        void window.recall.getStatus().then(setStatus)
      } else if (msg.event === 'engineStopped') setEngineStopped(true)
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

  if (!status) return engineStopped ? <EngineStoppedScreen /> : <Splash />
  if (status.problem) return <IndexProblemScreen problem={status.problem} />
  if (!splashDone) return <Splash />

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
        <Logo size={36} className="brand" />
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
        {engineStopped && (
          <div className="banner banner-warn" role="alert">
            Recall’s indexer stopped after several problems in a row. Search and indexing are unavailable.
            <button className="link" onClick={() => void window.recall.restartEngine()}>Restart indexer</button>
          </div>
        )}
        {status.rebuilt && !rebuiltDismissed && (
          <div className="banner banner-info" role="status">
            Recall rebuilt its index from your folders. Results fill in as it reads your files again.
            <button className="link" onClick={() => setRebuiltDismissed(true)}>Dismiss</button>
          </div>
        )}
        {engineNotice && (
          <div className="banner banner-info" role="status">
            Recall’s indexer restarted after a problem. No data was lost.
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
