export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** "C:\Users\maya\Documents\Clients\Acme" -> "…\Clients\Acme" */
export function shortFolder(fullPath: string, keep = 2): string {
  const parts = fullPath.split('\\')
  parts.pop()
  if (parts.length <= keep + 1) return parts.join('\\')
  return '…\\' + parts.slice(-keep).join('\\')
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`
}
