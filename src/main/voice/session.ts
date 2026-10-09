// One spoken exchange, from the wake word to the result (plan 12 §2). Pure: time comes from the caller and the
// result is a list of actions for the controller, so every transition is unit-tested without Electron.
import { stripHeardWakeWord } from '../../shared/wake-word'
import { classify, isRevealRequest, parseOrdinal, type Intent } from './intent'

export type SessionState = 'idle' | 'prompting' | 'awaitRequest' | 'working' | 'followUp'

export type SessionAction =
  | { type: 'showPrompt' }
  | { type: 'showAwaitRequest' }
  | { type: 'expectUtterance'; ms: number }
  | { type: 'findFiles'; query: string; folder: boolean; heard: string }
  | { type: 'ask'; question: string; heard: string }
  | { type: 'select'; position: number | 'last' }
  | { type: 'reveal' }
  | { type: 'close' }

/** Silence after the prompt before it closes (plan 12 FR-VOICE-04). */
export const PROMPT_MS = 8000
/** Listening without the wake word after a file result (FR-VOICE-09). */
export const FOLLOW_UP_MS = 10_000

export class VoiceSession {
  private state: SessionState = 'idle'
  private deadline = 0

  get current(): SessionState {
    return this.state
  }

  onWake(now: number): SessionAction[] {
    // A wake word while a request is running is ignored; anywhere else it starts over.
    if (this.state === 'working') return []
    this.enter('prompting', now + PROMPT_MS)
    return [{ type: 'showPrompt' }]
  }

  /** `withWake`: the utterance holds the wake word, which is removed first however it was misheard. */
  onUtterance(text: string, now: number, withWake = false): SessionAction[] {
    if (withWake) text = stripHeardWakeWord(text)
    if (this.state === 'prompting' || this.state === 'awaitRequest') return this.onRequest(classify(text), text, now)
    if (this.state === 'followUp') return this.onFollowUp(text, now)
    return []
  }

  /** The file results are on screen: listen briefly for "the second one" or "show in folder". */
  onFilesShown(now: number): SessionAction[] {
    if (this.state !== 'working') return []
    this.enter('followUp', now + FOLLOW_UP_MS)
    return [{ type: 'expectUtterance', ms: FOLLOW_UP_MS }]
  }

  /** An answer or a problem is on screen; it stays until dismissed, but nothing more is heard. */
  onFinished(): void {
    if (this.state === 'working') this.enter('idle', 0)
  }

  onDismiss(): SessionAction[] {
    this.enter('idle', 0)
    return [{ type: 'close' }]
  }

  /** Called regularly by the controller; closes an unanswered prompt and ends the follow-up window. */
  tick(now: number): SessionAction[] {
    if ((this.state === 'prompting' || this.state === 'awaitRequest') && now > this.deadline) {
      this.enter('idle', 0)
      return [{ type: 'close' }]
    }
    if (this.state === 'followUp' && now > this.deadline) this.enter('idle', 0)
    return []
  }

  private onRequest(intent: Intent, heard: string, now: number): SessionAction[] {
    switch (intent.kind) {
      case 'empty':
        return []
      case 'refuse':
        return this.onDismiss()
      case 'agree':
        this.enter('awaitRequest', now + PROMPT_MS)
        return [{ type: 'showAwaitRequest' }, { type: 'expectUtterance', ms: PROMPT_MS }]
      case 'file':
        this.enter('working', 0)
        return [{ type: 'findFiles', query: intent.query, folder: intent.folder, heard }]
      case 'question':
        this.enter('working', 0)
        return [{ type: 'ask', question: intent.text, heard }]
    }
  }

  private onFollowUp(text: string, now: number): SessionAction[] {
    const remaining = Math.max(0, this.deadline - now)
    const position = parseOrdinal(text)
    if (position !== undefined) {
      this.deadline = now + FOLLOW_UP_MS
      return [{ type: 'select', position }, { type: 'expectUtterance', ms: FOLLOW_UP_MS }]
    }
    if (isRevealRequest(text)) return [{ type: 'reveal' }, { type: 'expectUtterance', ms: remaining }]
    const intent = classify(text)
    if (intent.kind === 'refuse') return this.onDismiss()
    // A new request without the wake word is answered like one that followed it.
    if (intent.kind === 'file' || intent.kind === 'question') return this.onRequest(intent, text, now)
    return [{ type: 'expectUtterance', ms: remaining }]
  }

  private enter(state: SessionState, deadline: number): void {
    this.state = state
    this.deadline = deadline
  }
}
