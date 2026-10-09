import { describe, expect, it } from 'vitest'
import { MAX_ASK_HISTORY, parseAskHistory, withAskEntry, type AskHistoryEntry } from '../../src/shared/ask-history'

const entry = (id: string): AskHistoryEntry => ({
  id,
  question: `question ${id}`,
  answer: 'An answer [1].',
  sources: [{ n: 1, fileId: 7, name: 'notes.txt', snippet: 'a passage' }],
  insufficient: false,
  invalidCitations: [],
  model: 'qwen',
  at: 1
})

describe('ask history', () => {
  it('puts the newest first and caps the list', () => {
    let list: AskHistoryEntry[] = []
    for (let i = 0; i < MAX_ASK_HISTORY + 3; i++) list = withAskEntry(list, entry(String(i)))
    expect(list).toHaveLength(MAX_ASK_HISTORY)
    expect(list[0].id).toBe(String(MAX_ASK_HISTORY + 2))
  })

  it('replaces an entry saved twice instead of duplicating it', () => {
    const list = withAskEntry(withAskEntry([entry('a')], entry('b')), { ...entry('a'), answer: 'longer' })
    expect(list.map((e) => e.id)).toEqual(['a', 'b'])
    expect(list[0].answer).toBe('longer')
  })

  it('reads back what it stored and drops malformed entries', () => {
    const stored = JSON.stringify([entry('a'), { id: 'b' }, null, { ...entry('c'), sources: [{ n: '1' }] }])
    expect(parseAskHistory(stored).map((e) => e.id)).toEqual(['a'])
  })

  it('treats missing or broken storage as empty', () => {
    expect(parseAskHistory(null)).toEqual([])
    expect(parseAskHistory('{not json')).toEqual([])
    expect(parseAskHistory('{"id":"a"}')).toEqual([])
  })
})
