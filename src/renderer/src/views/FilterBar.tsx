import type { DateRange, FolderInfo, SearchFilters, TemporalIntent, TypeFilter } from '../../../shared/types'
import { formatDate } from '../format'

// Plan doc 04 §6.3 / §6.6 (S4-01, S4-02): type, folder and date filters, with every active filter, and
// anything the query's time words were taken to mean, shown as a removable chip.

const TYPE_LABEL: Record<TypeFilter, string> = { pdf: 'PDF', docx: 'Word', notes: 'Notes and text', code: 'Code', images: 'Images' }

const DATE_PRESETS = [
  { days: 7, label: 'Past 7 days' },
  { days: 30, label: 'Past 30 days' },
  { days: 365, label: 'Past year' }
]

const FOREVER = 8.64e15

function presetRange(days: number, label: string): DateRange {
  const today = new Date()
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - days + 1)
  return { from: +from, to: FOREVER, label }
}

export function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

export function hasActiveFilters(f: SearchFilters): boolean {
  return !!(f.type || f.folderId !== undefined || f.modified)
}

/** "2 Mar 2026 – 8 Mar 2026"; open-ended ranges read "since …". */
function rangeDates(r: DateRange): string {
  if (r.to >= FOREVER) return `Since ${formatDate(r.from)}`
  return `${formatDate(r.from)} – ${formatDate(r.to - 1)}`
}

export function FilterBar({
  filters,
  onChange,
  folders,
  temporal,
  onDropTemporal
}: {
  filters: SearchFilters
  onChange: (f: SearchFilters) => void
  folders: FolderInfo[]
  /** What the last search took the query's time words to mean. */
  temporal?: TemporalIntent
  /** Search the time words as ordinary words instead. */
  onDropTemporal: () => void
}) {
  const set = (patch: Partial<SearchFilters>) => onChange({ ...filters, ...patch })
  const folder = folders.find((f) => f.id === filters.folderId)
  // A detected date range only applies when no date filter was picked (the engine's rule too).
  const detectedRange = !filters.modified ? temporal?.range : undefined

  const chips: { key: string; label: string; title?: string; remove: () => void; removeLabel: string }[] = []
  if (filters.type) chips.push({ key: 'type', label: TYPE_LABEL[filters.type], remove: () => set({ type: undefined }), removeLabel: `Remove the ${TYPE_LABEL[filters.type]} filter` })
  if (folder) {
    chips.push({ key: 'folder', label: `In ${folderName(folder.path)}`, title: folder.path, remove: () => set({ folderId: undefined }), removeLabel: `Remove the ${folderName(folder.path)} folder filter` })
  }
  if (filters.modified) {
    chips.push({ key: 'date', label: filters.modified.label, title: rangeDates(filters.modified), remove: () => set({ modified: undefined }), removeLabel: `Remove the ${filters.modified.label} filter` })
  }
  if (detectedRange) {
    chips.push({
      key: 'detected-date',
      label: `Modified: ${detectedRange.label}`,
      title: `${rangeDates(detectedRange)}. Taken from your search words.`,
      remove: onDropTemporal,
      removeLabel: `Don’t limit to ${detectedRange.label}; search the words as typed`
    })
  }
  if (temporal?.newest) {
    chips.push({ key: 'newest', label: 'Newest first', title: 'Recent files rank higher. Taken from your search words.', remove: onDropTemporal, removeLabel: 'Don’t rank newest first; search the words as typed' })
  }

  const datePreset = DATE_PRESETS.find((p) => p.label === filters.modified?.label)

  return (
    <div className="filter-bar">
      <div className="filter-selects" role="group" aria-label="Filters">
        <select
          className={`filter-select ${filters.type ? 'active' : ''}`}
          aria-label="File type"
          value={filters.type ?? ''}
          onChange={(e) => set({ type: (e.target.value || undefined) as TypeFilter | undefined })}
        >
          <option value="">Any type</option>
          {(Object.keys(TYPE_LABEL) as TypeFilter[]).map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t]}</option>
          ))}
        </select>
        {folders.length > 1 && (
          <select
            className={`filter-select ${folder ? 'active' : ''}`}
            aria-label="Folder"
            value={folder ? String(folder.id) : ''}
            onChange={(e) => set({ folderId: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">All folders</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id} title={f.path}>{folderName(f.path)}</option>
            ))}
          </select>
        )}
        <select
          className={`filter-select ${filters.modified ? 'active' : ''}`}
          aria-label="Modified"
          value={datePreset ? String(datePreset.days) : ''}
          onChange={(e) => {
            const p = DATE_PRESETS.find((x) => String(x.days) === e.target.value)
            set({ modified: p ? presetRange(p.days, p.label) : undefined })
          }}
        >
          <option value="">Any time</option>
          {DATE_PRESETS.map((p) => (
            <option key={p.days} value={p.days}>{p.label}</option>
          ))}
        </select>
      </div>
      {chips.length > 0 && (
        <ul className="filter-chips" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.key} className="filter-chip" title={c.title}>
              <span>{c.label}</span>
              <button aria-label={c.removeLabel} onClick={c.remove}>×</button>
            </li>
          ))}
          {hasActiveFilters(filters) && (
            <li>
              <button className="link" onClick={() => onChange({})}>Clear filters</button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
