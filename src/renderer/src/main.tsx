import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initVoiceCapture } from './voice/capture'
import './tokens.css'
import './shared.css'
import './styles.css'

// Outside React: capture must keep running across views and while the window is hidden in the tray.
initVoiceCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
