// Deterministic routing of a spoken request (plan 12 §6.3, D-19): no LLM decides what a request means.
// Every misroute found in testing becomes a case in tests/unit/voice-intent.test.ts.

export type Intent =
  | { kind: 'empty' }
  | { kind: 'refuse' }
  | { kind: 'agree' }
  | { kind: 'file'; query: string; folder: boolean }
  | { kind: 'question'; text: string }

const REFUSAL = /^(no|nope|nah|no thanks|no thank you|never ?mind|nevermind|cancel|stop|not now|nothing|forget it|that's all|that is all)$/
const AGREEMENT = /^(yes|yeah|yep|yup|yes please|sure|okay|ok|please|i do|uh huh|go ahead|of course|absolutely|right|yes i do|yeah i do)$/
const AGREEMENT_PREFIX = /^(yes|yeah|yep|yup|sure|okay|ok)( please)?\s+/
// Polite openers that carry no meaning for routing.
const POLITE_PREFIX = /^(please\s+|can you\s+|could you\s+|would you\s+|will you\s+|i need you to\s+|i want you to\s+|i need to\s+|i want to\s+|help me\s+|recall\s+)+/
const FILE_VERB =
  /^(find|open|show( me)?|where is|where's|where are|where did i (save|put|keep)|locate|get( me)?|look for|looking for|i'm looking for|i am looking for|search for|pull up|bring up|go to)\b/
const QUESTION_START =
  /^(what|what's|when|when's|who|who's|whom|why|how|which|did|does|do|is|are|was|were|can|could|should|will|would|has|have|summarize|summarise|tell me|explain|describe|list|compare)\b/
const FILE_NOUN = /\b(file|files|folder|folders|directory|document|documents|doc|docs|pdf|spreadsheet|presentation|slides|deck|photo|photos|picture|pictures|image|notes)\b/
const FOLDER_NOUN = /\b(folder|folders|directory|directories)\b/
const WHICH_FILE = /^(which|is there an?|are there any|do i have an?|do i have any) (file|files|folder|document|documents|doc|pdf|spreadsheet|presentation)\b/

/** Lowercase, plain words only; keeps apostrophes so "where's" still matches. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Removes the wake word at the start ("recall", "hey recall", "ok recall"). */
export function stripWakeWord(text: string): string {
  return text.replace(/^((hey|hi|ok|okay)\s+)?recall\b\s*/, '')
}

/** The search words of a file request: the verb phrase, filler words and the word "folder" removed. */
function fileQuery(t: string, folder: boolean): string {
  let q = t.replace(FILE_VERB, '').trim()
  q = q.replace(/^(me|for|to)\s+/, '')
  q = q.replace(/^((my|the|a|an|our|that|this|those|these|all|some)\s+)+/, '')
  if (folder) {
    // "the folder with the design mockups" → "design mockups"
    q = q.replace(FOLDER_NOUN, ' ').trim()
    q = q.replace(/^((with|about|for|from|of|containing|named|called|that has|that have)\s+)+/, '')
    q = q.replace(/^((my|the|a|an|our|that|this|those|these|all|some)\s+)+/, '')
  }
  q = q.replace(/\b(please|for me)\b/g, ' ').replace(/\s+/g, ' ').trim()
  return q || t
}

export function classify(raw: string): Intent {
  let t = stripWakeWord(normalize(raw))
  if (!t) return { kind: 'empty' }
  if (REFUSAL.test(t)) return { kind: 'refuse' }
  if (AGREEMENT.test(t)) return { kind: 'agree' }
  t = t.replace(AGREEMENT_PREFIX, '').replace(POLITE_PREFIX, '').trim()
  if (!t) return { kind: 'agree' }
  const folder = FOLDER_NOUN.test(t)
  if (FILE_VERB.test(t) || WHICH_FILE.test(t)) return { kind: 'file', query: fileQuery(t, folder), folder }
  if (QUESTION_START.test(t)) return { kind: 'question', text: t }
  if (FILE_NOUN.test(t)) return { kind: 'file', query: fileQuery(t, folder), folder }
  // A bare noun phrase ("the Acme contract") is a file request.
  return { kind: 'file', query: fileQuery(t, folder), folder }
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1, one: 1, '1st': 1, '1': 1,
  second: 2, two: 2, '2nd': 2, '2': 2,
  third: 3, three: 3, '3rd': 3, '3': 3,
  fourth: 4, four: 4, '4th': 4, '4': 4,
  fifth: 5, five: 5, '5th': 5, '5': 5
}

/** "the second one", "number 3", "the last one" → 1-based position, or 'last'. Undefined if it isn't a pick. */
export function parseOrdinal(raw: string): number | 'last' | undefined {
  const t = normalize(raw).replace(/^(yes|yeah|ok|okay)\s+/, '')
  const m = /^(?:(?:i want|give me|copy|take|pick|choose|use|open)\s+)?(?:the\s+)?(?:number|option|match)?\s*(\w+)(?:\s+(?:one|match|file|result|option))?(?:\s+please)?$/.exec(t)
  if (!m) return undefined
  if (m[1] === 'last') return 'last'
  return ORDINAL_WORDS[m[1]]
}

/** "show in folder", "open the folder", "show it in explorer". */
export function isRevealRequest(raw: string): boolean {
  return /^(show|open|reveal)( it| me)?( in)?( the)? (folder|explorer|file explorer|location)$/.test(normalize(raw))
}
