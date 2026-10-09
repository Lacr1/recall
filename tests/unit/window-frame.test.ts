// The frameless main window: which size it opens at, and what the title bar may ask main to do.
import { describe, expect, it } from 'vitest'
import { fitSize, parseWindowAction, parseWindowMode, startsInOnboarding, WINDOW_SIZE } from '../../src/main/window-frame'

describe('window frame', () => {
  it('opens as the onboarding card on first run (no folder list, or no folders in it)', () => {
    expect(startsInOnboarding(undefined)).toBe(true)
    expect(startsInOnboarding('{"version":1,"folders":[],"paused":false}')).toBe(true)
    expect(startsInOnboarding('not json')).toBe(true)
    expect(startsInOnboarding('{"version":1,"folders":[{"id":1,"path":"C:\\\\Docs"}]}')).toBe(false)
  })

  it('never opens taller or wider than the screen work area', () => {
    expect(fitSize(WINDOW_SIZE.onboarding, { width: 1920, height: 1040 })).toEqual(WINDOW_SIZE.onboarding)
    expect(fitSize(WINDOW_SIZE.app, { width: 1366, height: 728 })).toEqual({ width: 1280, height: 728 })
  })

  it('accepts only known modes and title bar actions', () => {
    expect(parseWindowMode('onboarding')).toBe('onboarding')
    expect(parseWindowMode('app')).toBe('app')
    expect(parseWindowMode('fullscreen')).toBeUndefined()
    for (const a of ['minimize', 'maximize', 'close']) expect(parseWindowAction(a)).toBe(a)
    expect(parseWindowAction('quit')).toBeUndefined()
    expect(parseWindowAction(undefined)).toBeUndefined()
  })
})
