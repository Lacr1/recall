// The voice popup's only surface: receive what to show, send back validated actions (plan 12 §5.1).
import { contextBridge, ipcRenderer } from 'electron'
import type { PopupState, RecallPopupApi } from '../shared/popup'

// Main may send the first state before the page has subscribed, so the latest one is kept and replayed.
let latest: PopupState | undefined
const stateListeners = new Set<(s: PopupState) => void>()
ipcRenderer.on('popup:state', (_e, s: PopupState) => {
  latest = s
  stateListeners.forEach((l) => l(s))
})

const api: RecallPopupApi = {
  onState: (listener) => {
    stateListeners.add(listener)
    if (latest) listener(latest)
    return () => stateListeners.delete(listener)
  },
  onLevel: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, rms: number) => listener(rms)
    ipcRenderer.on('popup:level', handler)
    return () => ipcRenderer.removeListener('popup:level', handler)
  },
  action: (a) => ipcRenderer.invoke('popup:action', a)
}

contextBridge.exposeInMainWorld('recallPopup', Object.freeze(api))
