// Popup placement, folder matching, popup action validation and the copy deck (plan 12 S8-06/07).
import { describe, expect, it } from 'vitest'
import { placePopup, POINTER_GAP } from '../../src/main/voice/placement'
import { foldersOf, matchFolders } from '../../src/engine/folder-match'
import { parsePopupAction, POPUP_MAX_HEIGHT } from '../../src/shared/popup'
import * as copy from '../../src/shared/popup-copy'

const screen = { x: 0, y: 0, width: 1920, height: 1040 }
const card = { width: 400, height: 200 }

describe('placePopup', () => {
  it('sits below-right of the pointer', () => {
    expect(placePopup({ x: 500, y: 300 }, card, screen)).toEqual({ x: 500 + POINTER_GAP, y: 300 + POINTER_GAP })
  })

  it('flips left near the right edge and up near the bottom', () => {
    expect(placePopup({ x: 1800, y: 1000 }, card, screen)).toEqual({ x: 1800 - POINTER_GAP - 400, y: 1000 - POINTER_GAP - 200 })
  })

  it('never covers the pointer after flipping', () => {
    const p = { x: 1700, y: 900 }
    const pos = placePopup(p, card, screen)
    const covers = p.x >= pos.x && p.x <= pos.x + card.width && p.y >= pos.y && p.y <= pos.y + card.height
    expect(covers).toBe(false)
  })

  it('stays inside a second monitor to the left with a negative origin', () => {
    const left = { x: -1280, y: 0, width: 1280, height: 984 }
    const pos = placePopup({ x: -10, y: 970 }, card, left)
    expect(pos.x).toBeGreaterThanOrEqual(left.x)
    expect(pos.x + card.width).toBeLessThanOrEqual(left.x + left.width)
    expect(pos.y + card.height).toBeLessThanOrEqual(left.y + left.height)
  })

  it('stays inside a work area too small to flip into', () => {
    const tiny = { x: 0, y: 0, width: 420, height: 230 }
    const pos = placePopup({ x: 200, y: 100 }, card, tiny)
    expect(pos.x).toBeGreaterThanOrEqual(0)
    expect(pos.y).toBeGreaterThanOrEqual(0)
    expect(pos.x + card.width).toBeLessThanOrEqual(420)
  })

  it('works in scaled DIPs (150%: a 2560-px screen is 1707 DIPs wide)', () => {
    const scaled = { x: 0, y: 0, width: 1707, height: 960 }
    const pos = placePopup({ x: 1650, y: 50 }, card, scaled)
    expect(pos.x + card.width).toBeLessThanOrEqual(1707)
  })
})

describe('folder matching', () => {
  const dirs = foldersOf([
    { root: 'C:\\Users\\maya\\Documents', rel: 'Taxes\\2023\\return.pdf' },
    { root: 'C:\\Users\\maya\\Documents', rel: 'Taxes\\receipts.txt' },
    { root: 'C:\\Users\\maya\\Documents', rel: 'personal\\recipes\\lasagna.md' },
    { root: 'C:\\Users\\maya\\Documents', rel: 'Design Mockups\\home.png' },
    { root: 'D:\\Work', rel: 'clients\\acme\\proposal.docx' }
  ])

  it('lists every folder from the root down', () => {
    expect([...dirs]).toContain('C:\\Users\\maya\\Documents\\Taxes\\2023')
    expect([...dirs]).toContain('D:\\Work')
  })

  it('matches folder names, ignoring plurals, shallowest first', () => {
    const m = matchFolders('tax', dirs)
    expect(m[0].path).toBe('C:\\Users\\maya\\Documents\\Taxes')
    expect(matchFolders('recipe', dirs)[0].name).toBe('recipes')
    expect(matchFolders('design mockups', dirs)[0].name).toBe('Design Mockups')
    expect(matchFolders('acme', dirs)[0].path).toBe('D:\\Work\\clients\\acme')
  })

  it('returns nothing for words that match no folder or only stop words', () => {
    expect(matchFolders('passport', dirs)).toEqual([])
    expect(matchFolders('the my', dirs)).toEqual([])
  })
})

describe('popup actions from the page', () => {
  it.each([
    [{ type: 'dismiss' }, { type: 'dismiss' }],
    [{ type: 'select', index: 2 }, { type: 'select', index: 2 }],
    [{ type: 'openSource', fileId: 7 }, { type: 'openSource', fileId: 7 }],
    [{ type: 'hover', on: true }, { type: 'hover', on: true }],
    [{ type: 'resize', height: 9999 }, { type: 'resize', height: POPUP_MAX_HEIGHT }]
  ])('accepts %j', (raw, parsed) => {
    expect(parsePopupAction(raw)).toEqual(parsed)
  })

  it.each([
    null,
    'dismiss',
    { type: 'select', index: -1 },
    { type: 'select', index: 1.5 },
    { type: 'select', index: 99 },
    { type: 'openSource', fileId: 'C:\\x.exe' },
    { type: 'hover', on: 'yes' },
    { type: 'resize', height: -4 },
    { type: 'openPath', path: 'C:\\Windows' }
  ])('drops %j', (raw) => {
    expect(parsePopupAction(raw)).toBeUndefined()
  })
})

describe('copy deck', () => {
  it('keeps titles within 60 characters even for long requests', () => {
    const long = 'find the presentation for the quarterly client meeting about the new warehouse'
    expect(copy.workingFile(long).length).toBeLessThanOrEqual(60)
    expect(copy.problemCopy('noMatch', long).title.length).toBeLessThanOrEqual(60)
    for (const p of copy.PROMPTS) expect(p.length).toBeLessThanOrEqual(60)
  })

  it('rotates the prompt wording', () => {
    expect(new Set([0, 1, 2].map(copy.promptTitle)).size).toBe(3)
  })

  it('never uses error words in what the user sees', () => {
    const problems = ['noMatch', 'notInFiles', 'didntCatch', 'needsModel', 'needsAi', 'micProblem', 'answerFailed', 'busy'] as const
    for (const p of problems) {
      const c = copy.problemCopy(p, 'x')
      expect(`${c.title} ${c.detail} ${c.spoken}`).not.toMatch(/error|failed|exception|code/i)
    }
  })

  it('speaks answers without citation numbers or labels', () => {
    expect(copy.spokenAnswer('The payment is due on 15 March [1]. Inferred: half is paid upfront [2, 3].')).toBe(
      'The payment is due on 15 March. Half is paid upfront.'
    )
  })

  it('speaks copied files by name without the extension', () => {
    expect(copy.spokenCopied('Lease 2025.pdf', false)).toBe('Copied the path to Lease 2025.')
    expect(copy.spokenCopied('recipes', true)).toBe('Copied the path to the recipes folder.')
    expect(copy.spokenCopied('Lease 2024.pdf', false, 1)).toBe('Copied the second match, Lease 2024.')
  })

  it('shortens long folders in the middle', () => {
    expect(copy.middleEllipsis('C:\\Users\\maya\\Documents\\Housing\\Old')).toBe('C:\\Users\\…\\Housing\\Old')
    expect(copy.middleEllipsis('C:\\Docs')).toBe('C:\\Docs')
    expect(copy.middleEllipsis('C:\\Users\\maya\\Documents\\a-very-long-project-folder-name\\manuals')).toBe('…\\a-very-long-project-folder-name\\manuals')
  })
})
