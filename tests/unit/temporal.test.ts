import { describe, expect, it } from 'vitest'
import { FOREVER, parseTemporal } from '../../src/engine/temporal'
import { passageRefs, searchFilters } from '../../src/main/search-params'

// Saturday 10 October 2026, mid-afternoon local time.
const NOW = new Date(2026, 9, 10, 15, 30)
const day = (y: number, m: number, d: number) => +new Date(y, m - 1, d)

const parse = (q: string) => parseTemporal(q, NOW)

describe('time words in a query (plan doc 04 §6.6)', () => {
  it('leaves queries without time words alone', () => {
    for (const q of ['proposal with a 50% initial payment', 'invoice 2025-118', 'march of the penguins notes', 'may I have the recipe']) {
      expect(parse(q)).toEqual({ query: q })
    }
  })

  it('turns ordering words into newest-first and removes them from the words searched for', () => {
    expect(parse('latest acme proposal')).toEqual({ query: 'acme proposal', intent: { newest: true, range: undefined } })
    expect(parse('the most recent booking notes').query).toBe('booking notes')
    expect(parse('newest')).toEqual({ query: '', intent: { newest: true, range: undefined } })
  })

  it('reads relative days and weeks; weeks start on Monday', () => {
    expect(parse('notes from today').intent?.range).toEqual({ from: day(2026, 10, 10), to: day(2026, 10, 11), label: 'Today' })
    expect(parse('yesterday').intent?.range).toMatchObject({ from: day(2026, 10, 9), to: day(2026, 10, 10) })
    expect(parse('meeting notes from last week')).toEqual({
      query: 'meeting notes',
      intent: { newest: false, range: { from: day(2026, 9, 28), to: day(2026, 10, 5), label: 'Last week' } }
    })
    expect(parse('this week').intent?.range).toMatchObject({ from: day(2026, 10, 5), to: day(2026, 10, 12) })
    expect(parse('invoices from the past 30 days').intent?.range).toEqual({ from: day(2026, 9, 11), to: FOREVER, label: 'Past 30 days' })
    expect(parse('past week').intent?.range).toMatchObject({ from: day(2026, 10, 4), to: FOREVER })
  })

  it('reads months and years', () => {
    expect(parse('last month').intent?.range).toEqual({ from: day(2026, 9, 1), to: day(2026, 10, 1), label: 'September 2026' })
    expect(parse('budget this year').intent?.range).toMatchObject({ from: day(2026, 1, 1), to: day(2027, 1, 1), label: '2026' })
    expect(parse('proposal March 2026')).toEqual({
      query: 'proposal',
      intent: { newest: false, range: { from: day(2026, 3, 1), to: day(2026, 4, 1), label: 'March 2026' } }
    })
    // A month alone is the latest one that has started: November has not yet this year.
    expect(parse('receipts in november').intent?.range).toMatchObject({ from: day(2025, 11, 1), label: 'November 2025' })
    expect(parse('notes from may').intent?.range).toMatchObject({ from: day(2026, 5, 1), label: 'May 2026' })
    expect(parse('tax return 2025')).toEqual({
      query: 'tax return',
      intent: { newest: false, range: { from: day(2025, 1, 1), to: day(2026, 1, 1), label: '2025' } }
    })
  })

  it('does not read identifiers or future years as dates', () => {
    expect(parse('invoice-2025-118').intent).toBeUndefined()
    expect(parse('report_2024.pdf').intent).toBeUndefined()
    expect(parse('roadmap 2030').intent).toBeUndefined()
  })

  it('combines a range with ordering words', () => {
    expect(parse('latest proposal from last month')).toMatchObject({ query: 'proposal', intent: { newest: true, range: { label: 'September 2026' } } })
  })
})

describe('search parameters from the renderer', () => {
  it('keeps only valid filters', () => {
    expect(searchFilters({ type: 'pdf', folderId: 3, modified: { from: 1, to: 2, label: 'x' }, ignoreTemporal: true })).toEqual({
      type: 'pdf', folderId: 3, modified: { from: 1, to: 2, label: 'x' }, ignoreTemporal: true
    })
    expect(searchFilters({ type: 'exe', folderId: -1, modified: { from: 5, to: 1 }, ignoreTemporal: 'yes' })).toEqual({})
    expect(searchFilters('pdf')).toEqual({})
    expect(searchFilters({ modified: { from: 0, to: 9e15, label: 'x' } })).toEqual({})
  })

  it('keeps well-formed passages, at most ten', () => {
    expect(passageRefs([{ chunkId: 1, start: 0, end: 10 }, { chunkId: 2, start: 5, end: 1 }, { chunkId: 'x' }, null])).toEqual([{ chunkId: 1, start: 0, end: 10 }])
    expect(passageRefs(Array.from({ length: 20 }, (_, i) => ({ chunkId: i, start: 0, end: 1 })))).toHaveLength(10)
    expect(passageRefs({})).toEqual([])
  })
})
