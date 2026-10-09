// The only permission Recall ever grants: microphone audio, to the main window's own page, for voice
// (plan 12 SEC-13). Camera, screen capture, notifications and everything else stay denied (plan doc 06 §5).

export interface PermissionRequest {
  permission: string
  /** The request comes from the main window (not the popup or any other webContents). */
  fromMainWindow: boolean
  /** Origin or URL of the requesting page. */
  url: string
  /** For `media` requests: the kinds of device asked for. */
  mediaTypes?: readonly string[]
  devUrl?: string
}

const isAppPage = (url: string, devUrl?: string) => url.startsWith('file://') || (!!devUrl && url.startsWith(devUrl.replace(/\/$/, '')))

export function allowPermissionRequest(r: PermissionRequest): boolean {
  if (r.permission !== 'media' || !r.fromMainWindow || !isAppPage(r.url, r.devUrl)) return false
  const types = r.mediaTypes ?? []
  return types.length > 0 && types.every((t) => t === 'audio')
}

/** Synchronous checks Chromium makes before and while capturing (e.g. device enumeration). */
export function allowPermissionCheck(r: { permission: string; fromMainWindow: boolean; mediaType?: string; url: string; devUrl?: string }): boolean {
  return r.permission === 'media' && r.fromMainWindow && r.mediaType === 'audio' && isAppPage(r.url, r.devUrl)
}
