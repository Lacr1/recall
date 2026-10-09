import { describe, expect, it } from 'vitest'
import { withRecent } from '../../src/shared/recent'

describe('recent searches', () => {
  it('puts the newest first, without duplicates, and keeps five', () => {
    let list: string[] = []
    for (const q of ['one', 'two', 'three', 'four', 'five', 'six', ' two ']) list = withRecent(list, q)
    expect(list).toEqual(['two', 'six', 'five', 'four', 'three'])
  })

  it('drops the half-typed searches a longer one extends', () => {
    expect(withRecent(['dishwasher'], 'Dishwasher warranty')).toEqual(['Dishwasher warranty'])
  })

  it('ignores empty searches', () => {
    expect(withRecent(['a'], '   ')).toEqual(['a'])
  })
})
