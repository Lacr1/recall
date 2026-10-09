import type { DateRange, SearchFilters, TemporalIntent } from '../shared/types'

// Plan doc 04 §6.6: a small rule-based parser. Ordering words make recent files rank higher; explicit
// ranges become a modified-date filter. Both are removed from the words that are searched for.

/** Upper bound for open-ended ranges ("past 3 months"): the largest valid JS date. */
export const FOREVER = 8.64e15

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const MONTH_NAMES = MONTHS.flatMap((m) => (m === 'may' ? [m] : [m, m.slice(0, 3)])).concat('sept')
const MONTH_RE = MONTH_NAMES.sort((a, b) => b.length - a.length).join('|')

const ORDERING = /\b(?:the\s+)?(?:most\s+recent(?:ly\s+(?:modified|updated|edited|changed))?|latest|newest|last\s+version|current\s+version|recently\s+(?:modified|updated|edited|changed)|updated|recent)\b/gi

// Prepositions that belong to the time phrase and go with it.
const PREP = String.raw`(?:(?:modified|edited|changed|written|created|saved|from|in|during|of)\s+)?`
const YEAR = String.raw`(?:19|20)\d{2}`

export interface TemporalParse {
  /** The query without its time words (may be empty, as for "latest"); the original when none were found. */
  query: string
  intent?: TemporalIntent
}

export function parseTemporal(q: string, now = new Date()): TemporalParse {
  let rest = q
  let range: DateRange | undefined

  for (const rule of rangeRules(now)) {
    const m = rule.re.exec(rest)
    if (!m) continue
    range = rule.range(m)
    if (range) {
      rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length)
      break
    }
  }

  let newest = false
  rest = rest.replace(ORDERING, () => {
    newest = true
    return ' '
  })

  if (!range && !newest) return { query: q }
  const query = rest.replace(/\s+/g, ' ').trim()
  return { query, intent: { newest, range } }
}

/**
 * What search runs for a typed query: the words without their time words, plus filters and ordering. The
 * time words are ignored when the user removed their chips; a detected date range applies only when the user
 * hasn't picked a date filter themselves.
 */
export function interpretQuery(q: string, filters: SearchFilters = {}, now = new Date()) {
  const { query, intent } = filters.ignoreTemporal ? { query: q, intent: undefined } : parseTemporal(q, now)
  return { query, intent, opts: { filters: { ...filters, modified: filters.modified ?? intent?.range }, newest: intent?.newest } }
}

interface RangeRule {
  re: RegExp
  range: (m: RegExpExecArray) => DateRange | undefined
}

function rangeRules(now: Date): RangeRule[] {
  const today = startOfDay(now)
  const week = startOfWeek(now)
  const month = new Date(now.getFullYear(), now.getMonth(), 1)
  const r = (from: Date | number, to: Date | number, label: string): DateRange => ({ from: +from, to: +to, label })
  const rule = (pattern: string, range: RangeRule['range']): RangeRule => ({ re: new RegExp(String.raw`\b${PREP}${pattern}\b`, 'i'), range })

  return [
    rule('today', () => r(today, addDays(today, 1), 'Today')),
    rule('yesterday', () => r(addDays(today, -1), today, 'Yesterday')),
    rule(String.raw`(?:the\s+)?(?:past|last)\s+(\d{1,3})\s+(day|week|month|year)s?`, (m) => {
      const n = Number(m[1])
      if (!n) return undefined
      const unit = m[2].toLowerCase()
      const from = unit === 'day' ? addDays(today, -n + 1) : unit === 'week' ? addDays(today, -7 * n + 1) : addMonths(today, unit === 'month' ? -n : -12 * n)
      return r(from, FOREVER, `Past ${n} ${unit}${n === 1 ? '' : 's'}`)
    }),
    rule(String.raw`(?:the\s+)?past\s+(week|month|year)`, (m) => {
      const unit = m[1].toLowerCase()
      const from = unit === 'week' ? addDays(today, -6) : addMonths(today, unit === 'month' ? -1 : -12)
      return r(from, FOREVER, `Past ${unit}`)
    }),
    rule(String.raw`this\s+week`, () => r(week, addDays(week, 7), 'This week')),
    rule(String.raw`last\s+week`, () => r(addDays(week, -7), week, 'Last week')),
    rule(String.raw`this\s+month`, () => r(month, addMonths(month, 1), 'This month')),
    rule(String.raw`last\s+month`, () => {
      const from = addMonths(month, -1)
      return r(from, month, monthLabel(from))
    }),
    rule(String.raw`this\s+year`, () => r(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear() + 1, 0, 1), String(now.getFullYear()))),
    rule(String.raw`last\s+year`, () => r(new Date(now.getFullYear() - 1, 0, 1), new Date(now.getFullYear(), 0, 1), String(now.getFullYear() - 1))),
    // "March 2026", "in March 2026"
    rule(String.raw`(${MONTH_RE})\.?\s+(${YEAR})`, (m) => {
      const from = new Date(Number(m[2]), monthIndex(m[1]), 1)
      return r(from, addMonths(from, 1), monthLabel(from))
    }),
    // A month alone only with a preposition ("in May"), since "may" and "march" are ordinary words too.
    // It means the latest such month that has started.
    {
      re: new RegExp(String.raw`\b(?:in|from|during)\s+(${MONTH_RE})\b`, 'i'),
      range: (m) => {
        const idx = monthIndex(m[1])
        const year = idx <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1
        const from = new Date(year, idx, 1)
        return r(from, addMonths(from, 1), monthLabel(from))
      }
    },
    // A year that stands alone; "2025-118" or "v2025" is an identifier, not a date.
    {
      re: new RegExp(String.raw`(?:\b(?:in|from|during)\s+)?(?<![\p{L}\p{N}\-_./])(${YEAR})(?![\p{L}\p{N}\-_./])`, 'iu'),
      range: (m) => {
        const y = Number(m[1])
        if (y > now.getFullYear()) return undefined
        return r(new Date(y, 0, 1), new Date(y + 1, 0, 1), String(y))
      }
    }
  ]
}

function monthIndex(name: string): number {
  const key = name.toLowerCase().slice(0, 3)
  return MONTHS.findIndex((m) => m.startsWith(key))
}

function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()][0].toUpperCase()}${MONTHS[d.getMonth()].slice(1)} ${d.getFullYear()}`
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Weeks start on Monday. */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d)
  return addDays(day, -((day.getDay() + 6) % 7))
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate())
}
