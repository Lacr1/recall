import { contextBridge, ipcRenderer } from 'electron'
import type { RecallApi } from './api'

const call = (channel: string, params?: unknown) => ipcRenderer.invoke(`recall:${channel}`, params ?? {})

const api: RecallApi = {
  getStatus: () => call('getStatus'),
  search: (requestId, query) => call('search', { requestId, query }),
  getDocument: (fileId) => call('getDocument', { fileId }),
  listFailures: () => call('listFailures'),
  addFolder: () => call('addFolder'),
  getFolderSuggestions: () => call('getFolderSuggestions'),
  addSuggestedFolder: (id) => call('addSuggestedFolder', { id }),
  removeFolder: (folderId) => call('removeFolder', { folderId }),
  rescanFolder: (folderId) => call('rescanFolder', { folderId }),
  retryFailed: () => call('retryFailed'),
  setPaused: (paused) => call('setPaused', { paused }),
  pullModel: () => call('pullModel'),
  startOllama: () => call('startOllama'),
  openOllamaDownload: () => call('openOllamaDownload'),
  ask: (askId, question) => call('ask', { askId, question }),
  cancelAsk: (askId) => call('cancelAsk', { askId }),
  openFile: (fileId) => call('openFile', { fileId }),
  revealFile: (fileId) => call('revealFile', { fileId }),
  copyPath: (fileId) => call('copyPath', { fileId }),
  deleteAllData: () => call('deleteAllData'),
  getDataInfo: () => call('getDataInfo'),
  rebuildIndex: () => call('rebuildIndex'),
  restartEngine: () => call('restartEngine'),
  onEvent: (listener) => {
    const handler = (_e: Electron.IpcRendererEvent, msg: Parameters<typeof listener>[0]) => listener(msg)
    ipcRenderer.on('recall:event', handler)
    return () => ipcRenderer.removeListener('recall:event', handler)
  }
}

contextBridge.exposeInMainWorld('recall', Object.freeze(api))
