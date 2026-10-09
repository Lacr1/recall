import { screen, type BrowserWindow } from 'electron'

// The main window has no Windows frame: Recall draws its own title bar (renderer TitleBar). During onboarding the
// window is only the setup card: fixed size, no maximize. Afterwards it is the normal resizable app window.

export type WindowMode = 'onboarding' | 'app'
export type WindowAction = 'minimize' | 'maximize' | 'close'

export const WINDOW_SIZE: Record<WindowMode, { width: number; height: number }> = {
  onboarding: { width: 880, height: 720 },
  app: { width: 1280, height: 820 }
}
export const APP_MIN_SIZE = { width: 900, height: 600 }

export function parseWindowMode(v: unknown): WindowMode | undefined {
  return v === 'onboarding' || v === 'app' ? v : undefined
}

export function parseWindowAction(v: unknown): WindowAction | undefined {
  return v === 'minimize' || v === 'maximize' || v === 'close' ? v : undefined
}

/**
 * First run opens straight into the card-sized window, so the splash doesn't jump. Same rule as the renderer's
 * (no folders yet); when they disagree, the renderer's setWindowMode corrects it once.
 */
export function startsInOnboarding(foldersJson: string | undefined): boolean {
  if (foldersJson === undefined) return true
  try {
    const folders = (JSON.parse(foldersJson) as { folders?: unknown }).folders
    return !Array.isArray(folders) || folders.length === 0
  } catch {
    return true
  }
}

/** Size within the screen's work area, so the window never opens taller than a small laptop screen. */
export function fitSize(size: { width: number; height: number }, workArea: { width: number; height: number }) {
  return { width: Math.min(size.width, workArea.width), height: Math.min(size.height, workArea.height) }
}

export function applyWindowMode(win: BrowserWindow, mode: WindowMode): void {
  const size = fitSize(WINDOW_SIZE[mode], screen.getDisplayMatching(win.getBounds()).workArea)
  if (win.isMaximized()) win.unmaximize()
  if (mode === 'onboarding') {
    win.setMinimumSize(size.width, size.height)
    win.setResizable(false)
    win.setMaximizable(false)
  } else {
    win.setResizable(true)
    win.setMaximizable(true)
    win.setMinimumSize(Math.min(APP_MIN_SIZE.width, size.width), Math.min(APP_MIN_SIZE.height, size.height))
  }
  win.setSize(size.width, size.height)
  win.center()
}
