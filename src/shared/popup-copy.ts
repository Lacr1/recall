// The popup's copy deck (plan 12 §5.1): every sentence it shows or speaks. Plain, short and friendly; titles at
// most 60 characters; never blames the user; always one next step; no error codes.
import type { PopupProblem } from './popup'

export const PROMPTS = ['Hi! What can I find for you?', "I'm listening. What do you need?", 'Yes? How can I help?']

export const promptTitle = (showCount: number) => PROMPTS[showCount % PROMPTS.length]
export const PROMPT_DETAIL = 'Try “find my lease” or ask a question.'
export const AWAIT_TITLE = 'Sure, go ahead.'
export const AWAIT_DETAIL = 'Tell me the file or the question.'
export const WORKING_QUESTION = 'Reading your files…'
export const WORKING_QUESTION_DETAIL = 'This can take a few seconds.'
export const NOT_THIS_ONE = 'Not this one?'
export const INDEXING_NOTE = 'Recall is still reading your files, so results may be incomplete.'
export const COPIED = 'Copied'

/** Quotes what the user said, shortened so a title stays within 60 characters. */
export function quoted(text: string, max = 40): string {
  const t = text.trim()
  return `“${t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t}”`
}

export const workingFile = (query: string) => `Looking for ${quoted(query)}…`

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth']
export const ordinal = (index: number) => ORDINALS[index] ?? `number ${index + 1}`
export const pickedOther = (index: number) => `Copied the ${ordinal(index)} match instead.`

export const weakTitle = (query: string) => `No strong match for ${quoted(query, 34)}.`
export const WEAK_DETAIL = 'Pick one to copy its path, or open Recall to search.'
export const SPOKEN_WEAK = "I'm not sure I found it. Pick one to copy its path."

export const filesHint = (count: number) => (count > 1 ? 'Say “the second one” · Esc to close' : 'Say “show in folder” · Esc to close')

export interface ProblemCopy {
  title: string
  detail: string
  action?: { label: string; type: 'openInRecall' | 'openSettings' | 'openMicSettings' }
  spoken: string
}

export function problemCopy(problem: PopupProblem, query = ''): ProblemCopy {
  switch (problem) {
    case 'noMatch':
      return {
        title: `I couldn't find ${quoted(query, 30)}.`,
        detail: 'Try other words, or open Recall to search.',
        action: { label: 'Open in Recall', type: 'openInRecall' },
        spoken: "I couldn't find that."
      }
    case 'notInFiles':
      return {
        title: "I couldn't find that in your files.",
        detail: "Your files don't seem to mention it.",
        action: { label: 'Open in Recall', type: 'openInRecall' },
        spoken: "I couldn't find that in your files."
      }
    case 'didntCatch':
      return { title: "Sorry, I didn't catch that.", detail: 'Say “Recall” to try again.', spoken: "Sorry, I didn't catch that." }
    case 'needsModel':
      return {
        title: 'I can find files, but answering questions needs the answer model.',
        detail: 'Set it up in Recall → Settings → Local AI.',
        action: { label: 'Open Settings', type: 'openSettings' },
        spoken: 'Answering questions needs the answer model. You can set it up in Recall settings.'
      }
    case 'needsAi':
      return {
        title: 'Answering questions needs local AI.',
        detail: 'Start Ollama, or set it up in Recall → Settings → Local AI.',
        action: { label: 'Open Settings', type: 'openSettings' },
        spoken: 'Answering questions needs local AI. You can set it up in Recall settings.'
      }
    case 'micProblem':
      return {
        title: "I can't hear the microphone.",
        detail: "Check that it's plugged in and allowed in Windows settings.",
        action: { label: 'Open microphone settings', type: 'openMicSettings' },
        spoken: "I can't hear the microphone."
      }
    case 'answerFailed':
      return {
        title: "I couldn't finish that answer.",
        detail: 'Try asking again, or open Recall to ask there.',
        action: { label: 'Open in Recall', type: 'openInRecall' },
        spoken: "I couldn't finish that answer."
      }
    case 'busy':
      return { title: 'Recall is restarting.', detail: 'Give it a moment, then say “Recall” again.', spoken: 'Recall is restarting. Try again in a moment.' }
  }
}

/** Spoken after a copy: the file name without its extension reads more naturally. */
export function spokenCopied(name: string, isFolder: boolean, picked?: number): string {
  const bare = isFolder ? `the ${name} folder` : name.replace(/\.[a-z0-9]{1,5}$/i, '')
  return picked ? `Copied the ${ordinal(picked)} match, ${bare}.` : `Copied the path to ${bare}.`
}

/** The answer as speech: citation numbers and "Inferred:" labels are for reading, not listening. */
export function spokenAnswer(text: string): string {
  return text
    .replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\bInferred:\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead: string, c: string) => lead + c.toUpperCase())
}

/**
 * "C:\Users\maya\Documents\Housing\Old" → "C:\Users\…\Housing\Old" so both ends stay readable. When that is still
 * long, only the end is kept ("…\Housing\Old"): the nearest folders are the ones that tell files apart.
 */
export function middleEllipsis(dir: string, keepEnd = 2, max = 44): string {
  const parts = dir.replace(/\\+$/, '').split('\\')
  if (parts.length <= keepEnd + 2) return parts.join('\\')
  const both = [parts[0], parts[1], '…', ...parts.slice(-keepEnd)].join('\\')
  return both.length <= max ? both : ['…', ...parts.slice(-keepEnd)].join('\\')
}
