import type { ReactNode } from 'react'
import type { HighlightRange } from '../../shared/types'
import logoUrl from './assets/logo.png'

/** Renders text with <mark> ranges. Text nodes only, never HTML from documents. */
export function Highlighted({ text, ranges }: { text: string; ranges: HighlightRange[] }) {
  const out: ReactNode[] = []
  let pos = 0
  ranges.forEach((r, i) => {
    if (r.start > pos) out.push(text.slice(pos, r.start))
    out.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>)
    pos = r.end
  })
  if (pos < text.length) out.push(text.slice(pos))
  return <>{out}</>
}

const TYPE_LABEL: Record<string, string> = { pdf: 'PDF', docx: 'DOC', md: 'MD', markdown: 'MD', txt: 'TXT', log: 'TXT' }
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'])

export function FileBadge({ ext }: { ext: string }) {
  const image = IMAGE_EXTS.has(ext)
  const label = image ? 'IMG' : (TYPE_LABEL[ext] ?? (ext.length <= 4 ? ext.toUpperCase() : 'CODE'))
  const tone = ext === 'pdf' ? 'pdf' : ext === 'docx' ? 'doc' : ext === 'md' || ext === 'txt' || image ? 'text' : 'code'
  return (
    <span className={`file-badge tone-${tone}`} aria-hidden="true">
      {label}
    </span>
  )
}

export type IconName = 'search' | 'ask' | 'folder' | 'settings' | 'laptop' | 'shield' | 'lock'

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, string> = {
    laptop: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v10h2v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2h2V5Zm2 1v9h12V6H6Z',
    shield:
      'M12 2l8 3v6c0 5-3.4 9.3-8 11-4.6-1.7-8-6-8-11V5l8-3Zm0 2.1L6 6.4V11c0 3.9 2.5 7.4 6 8.9 3.5-1.5 6-5 6-8.9V6.4l-6-2.3Zm3.3 5.2 1.4 1.4-5.7 5.7-3.4-3.4 1.4-1.4 2 2 4.3-4.3Z',
    lock: 'M12 2a5 5 0 0 1 5 5v3h1a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V11a1 1 0 0 1 1-1h1V7a5 5 0 0 1 5-5Zm0 2a3 3 0 0 0-3 3v3h6V7a3 3 0 0 0-3-3ZM7 12v8h10v-8H7Z',
    search: 'M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.25 4.24-1.42 1.42-4.24-4.25A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z',
    ask: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-4.4 3.3A1 1 0 0 1 3 19.5V5a1 1 0 0 1 1-1Zm1 2v11.5L8.3 15H19V6H5Zm3 3h8v2H8V9Zm0 3h5v2H8v-2Z',
    folder: 'M3 5a1 1 0 0 1 1-1h6l2 2h8a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5Zm2 1v12h14V8h-7.83l-2-2H5Z',
    settings:
      'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8Zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-1.2-8h2.4l.5 2.6 1.7.7 2.2-1.5 1.7 1.7-1.5 2.2.7 1.7 2.5.4v2.4l-2.5.5-.7 1.7 1.5 2.2-1.7 1.7-2.2-1.5-1.7.7-.5 2.5h-2.4l-.5-2.5-1.7-.7-2.2 1.5-1.7-1.7 1.5-2.2-.7-1.7L2 13.2v-2.4l2.6-.5.7-1.7-1.5-2.2 1.7-1.7 2.2 1.5 1.7-.7.4-2.5Z'
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
      <path d={paths[name]} fillRule="evenodd" />
    </svg>
  )
}

/** Recall's mark: the red panda. Decorative, so screen readers skip it. */
export function Logo({ size, className = '' }: { size: number; className?: string }) {
  return <img className={`logo ${className}`} src={logoUrl} width={size} height={size} alt="" draggable={false} />
}

export function ConfirmDialog(props: {
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  requireText?: string
  value?: string
  onValue?: (v: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const disabled = props.requireText !== undefined && props.value !== props.requireText
  return (
    <div className="dialog-backdrop" role="presentation" onKeyDown={(e) => e.key === 'Escape' && props.onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{props.title}</h2>
        <div className="dialog-body">{props.body}</div>
        {props.requireText !== undefined && (
          <input
            className="text-input"
            autoFocus
            aria-label={`Type ${props.requireText} to confirm`}
            placeholder={`Type ${props.requireText}`}
            value={props.value ?? ''}
            onChange={(e) => props.onValue?.(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={props.onCancel} autoFocus={props.requireText === undefined}>
            Cancel
          </button>
          <button className={props.danger ? 'btn btn-danger' : 'btn btn-primary'} disabled={disabled} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
