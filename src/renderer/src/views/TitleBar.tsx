import { useEffect, useState } from 'react'
import { Logo } from '../components'

/**
 * Recall's own title bar: the window has no Windows frame. Drag it to move the window; double-click to maximize.
 * `compact` is the onboarding card: a larger logo and name, and no maximize button.
 */
export function TitleBar({ compact = false }: { compact?: boolean }) {
  const [maximized, setMaximized] = useState(false)

  useEffect(
    () =>
      window.recall.onEvent((e) => {
        if (e.event === 'window') setMaximized(e.maximized)
      }),
    []
  )

  return (
    <header className={`titlebar ${compact ? 'titlebar-compact' : ''}`}>
      <span className="titlebar-brand">
        <Logo size={compact ? 26 : 16} />
        <span className="titlebar-name">Recall</span>
      </span>
      <span className="titlebar-controls">
        <button className="titlebar-btn" aria-label="Minimize" title="Minimize" onClick={() => void window.recall.windowControl('minimize')}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" />
          </svg>
        </button>
        {!compact && (
          <button
            className="titlebar-btn"
            aria-label={maximized ? 'Restore' : 'Maximize'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void window.recall.windowControl('maximize')}
          >
            <svg viewBox="0 0 10 10" aria-hidden="true">
              {maximized ? <path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /> : <path d="M.5.5h9v9h-9z" />}
            </svg>
          </button>
        )}
        <button className="titlebar-btn titlebar-close" aria-label="Close window" title="Close" onClick={() => void window.recall.windowControl('close')}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M.5.5l9 9M9.5.5l-9 9" />
          </svg>
        </button>
      </span>
    </header>
  )
}
