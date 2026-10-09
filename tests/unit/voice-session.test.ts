// Every transition of the spoken exchange (plan 12 §2), with an injected clock.
import { describe, expect, it } from 'vitest'
import { FOLLOW_UP_MS, PROMPT_MS, VoiceSession } from '../../src/main/voice/session'

const T = 1_000_000

describe('prompt', () => {
  it('wake word shows the prompt', () => {
    const s = new VoiceSession()
    expect(s.onWake(T)).toEqual([{ type: 'showPrompt' }])
    expect(s.current).toBe('prompting')
  })

  it('closes after 8 s of silence, not before', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.tick(T + PROMPT_MS)).toEqual([])
    expect(s.tick(T + PROMPT_MS + 1)).toEqual([{ type: 'close' }])
    expect(s.current).toBe('idle')
  })

  it('refusal closes it', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('no thanks', T + 1000)).toEqual([{ type: 'close' }])
  })

  it('a bare "Recall" utterance changes nothing', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('Recall.', T + 500)).toEqual([])
    expect(s.current).toBe('prompting')
  })

  it('a misheard wake word is not a request', () => {
    // Real voices: the second "Recall" was transcribed "We call." and searched for.
    const s = new VoiceSession()
    s.onWake(T)
    for (const heard of ['We call.', 'The call.', 'Cool', 'Re-call.', 'Hey, we call.']) expect(s.onUtterance(heard, T + 500, true)).toEqual([])
    expect(s.current).toBe('prompting')
  })

  it('"Recall" said again while the prompt is open is not a request', () => {
    // The voice process marks a lone "We call." as holding the wake word even when the spotter missed it.
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('We call.', T + 3000, true)).toEqual([])
    expect(s.onUtterance('find my resume', T + 5000)).toEqual([{ type: 'findFiles', query: 'resume', folder: false, heard: 'find my resume' }])
  })

  it('a misheard wake word is removed from a request said in one breath', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('We call, find my resume.', T + 100, true)).toEqual([{ type: 'findFiles', query: 'resume', folder: false, heard: 'Find my resume.' }])
    const s2 = new VoiceSession()
    s2.onWake(T)
    expect(s2.onUtterance('The call yes', T + 100, true)).toEqual([{ type: 'showAwaitRequest' }, { type: 'expectUtterance', ms: PROMPT_MS }])
  })

  it('without the wake word in it, "the call" is a request like any other', () => {
    const s = new VoiceSession()
    s.onWake(T)
    s.onUtterance('yes', T + 100)
    expect(s.onUtterance('The call notes', T + 2000)).toEqual([{ type: 'findFiles', query: 'call notes', folder: false, heard: 'The call notes' }])
  })

  it('"yes" asks for the request and waits again', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('Yeah.', T + 2000)).toEqual([{ type: 'showAwaitRequest' }, { type: 'expectUtterance', ms: PROMPT_MS }])
    expect(s.current).toBe('awaitRequest')
    expect(s.tick(T + 2000 + PROMPT_MS)).toEqual([])
    expect(s.tick(T + 2001 + PROMPT_MS)).toEqual([{ type: 'close' }])
  })
})

describe('requests', () => {
  it('one-shot file request', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onUtterance('Recall, find my resume.', T + 100)).toEqual([
      { type: 'findFiles', query: 'resume', folder: false, heard: 'Recall, find my resume.' }
    ])
    expect(s.current).toBe('working')
  })

  it('question after "yes"', () => {
    const s = new VoiceSession()
    s.onWake(T)
    s.onUtterance('yes', T + 1000)
    expect(s.onUtterance('When is the Acme payment due?', T + 3000)).toEqual([
      { type: 'ask', question: 'when is the acme payment due', heard: 'When is the Acme payment due?' }
    ])
  })

  it('ignores speech and a new wake word while working', () => {
    const s = new VoiceSession()
    s.onWake(T)
    s.onUtterance('find my resume', T + 100)
    expect(s.onWake(T + 200)).toEqual([])
    expect(s.onUtterance('find my taxes', T + 300)).toEqual([])
  })

  it('ignores utterances when idle', () => {
    expect(new VoiceSession().onUtterance('find my resume', T)).toEqual([])
  })
})

describe('follow-up after file results', () => {
  const shown = () => {
    const s = new VoiceSession()
    s.onWake(T)
    s.onUtterance('find my lease', T + 100)
    expect(s.onFilesShown(T + 500)).toEqual([{ type: 'expectUtterance', ms: FOLLOW_UP_MS }])
    return s
  }

  it('"the second one" picks another match and keeps listening', () => {
    const s = shown()
    expect(s.onUtterance('the second one', T + 2000)).toEqual([{ type: 'select', position: 2 }, { type: 'expectUtterance', ms: FOLLOW_UP_MS }])
    expect(s.current).toBe('followUp')
  })

  it('"show in folder" reveals the file', () => {
    const s = shown()
    expect(s.onUtterance('show in folder', T + 2500)[0]).toEqual({ type: 'reveal' })
  })

  it('"never mind" closes', () => {
    expect(shown().onUtterance('never mind', T + 1000)).toEqual([{ type: 'close' }])
  })

  it('a new request without the wake word is handled', () => {
    expect(shown().onUtterance('find my passport', T + 1000)).toEqual([
      { type: 'findFiles', query: 'passport', folder: false, heard: 'find my passport' }
    ])
  })

  it('stops listening when the window ends but leaves the results open', () => {
    const s = shown()
    expect(s.tick(T + 500 + FOLLOW_UP_MS + 1)).toEqual([])
    expect(s.current).toBe('idle')
    expect(s.onUtterance('the second one', T + 20_000)).toEqual([])
  })

  it('a wake word during the follow-up starts over', () => {
    const s = shown()
    expect(s.onWake(T + 3000)).toEqual([{ type: 'showPrompt' }])
  })
})

describe('answers and dismissal', () => {
  it('after an answer nothing more is heard', () => {
    const s = new VoiceSession()
    s.onWake(T)
    s.onUtterance('when is the payment due', T + 100)
    s.onFinished()
    expect(s.current).toBe('idle')
    expect(s.onUtterance('the second one', T + 1000)).toEqual([])
  })

  it('dismiss from anywhere closes', () => {
    const s = new VoiceSession()
    s.onWake(T)
    expect(s.onDismiss()).toEqual([{ type: 'close' }])
    expect(s.current).toBe('idle')
  })
})
