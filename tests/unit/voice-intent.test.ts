// Routing rules for spoken requests (plan 12 §6.3). Add every misroute found in testing as a row here.
import { describe, expect, it } from 'vitest'
import { classify, isRevealRequest, parseOrdinal, stripWakeWord, normalize } from '../../src/main/voice/intent'
import { isHeardWakeWordAlone, stripHeardWakeWord } from '../../src/shared/wake-word'

const file = (query: string, folder = false) => ({ kind: 'file', query, folder })
const question = (text: string) => ({ kind: 'question', text })

describe('classify', () => {
  it.each([
    // The 30 request phrases from the S8-01 spike.
    ['find my resume', file('resume')],
    ['where is the lease agreement', file('lease agreement')],
    ['open the budget spreadsheet', file('budget spreadsheet')],
    ['find my tax folder', file('tax', true)],
    ['show me the meeting notes from Monday', file('meeting notes from monday')],
    ['when is the Acme payment due', question('when is the acme payment due')],
    ['what did we decide about the marketing budget', question('what did we decide about the marketing budget')],
    ['find the contract with a deposit', file('contract with a deposit')],
    ['where are my vacation photos', file('vacation photos')],
    ['find the invoice from the Lisbon trip', file('invoice from the lisbon trip')],
    ['summarize the project proposal', question('summarize the project proposal')],
    ['who is the contact for the booking app', question('who is the contact for the booking app')],
    ['find the latest version of the proposal', file('latest version of the proposal')],
    ['where is the insurance policy document', file('insurance policy document')],
    ['open the quarterly report', file('quarterly report')],
    ['what is the deadline for the grant application', question('what is the deadline for the grant application')],
    ['find the presentation for the client meeting', file('presentation for the client meeting')],
    ['how much was the last electricity bill', question('how much was the last electricity bill')],
    ['find my notes about the database migration', file('notes about the database migration')],
    ['where did I save the wedding guest list', file('wedding guest list')],
    ['show me the PDF about the warranty', file('pdf about the warranty')],
    ['which file mentions the server password policy', file('which file mentions the server password policy')],
    ['find the spreadsheet with the team schedule', file('spreadsheet with the team schedule')],
    ['what is the refund policy in the terms', question('what is the refund policy in the terms')],
    ['find the folder with the design mockups', file('design mockups', true)],
    ['where is the onboarding checklist', file('onboarding checklist')],
    ['find the email draft to the landlord', file('email draft to the landlord')],
    ['when does my car insurance expire', question('when does my car insurance expire')],
    ['find the code for the authentication session', file('code for the authentication session')],
    ['open the notes from the doctor appointment', file('notes from the doctor appointment')],
    // Wake word, agreement and polite openers in front of the request.
    ['Recall, find my resume.', file('resume')],
    ['Hey Recall, where is the lease?', file('lease')],
    ['Yeah, where is my lease agreement?', file('lease agreement')],
    ['Yes please, when is the Acme payment due?', question('when is the acme payment due')],
    ['Can you find my resume?', file('resume')],
    ['Could you tell me when the invoice is due?', question('tell me when the invoice is due')],
    ["I'm looking for the Acme contract", file('acme contract')],
    ['Is there a file about my passport?', file('is there a file about my passport')],
    ['the Acme contract', file('acme contract')],
    ['tax documents from last year', file('tax documents from last year')]
  ])('%s', (text, expected) => {
    expect(classify(text)).toEqual(expected)
  })

  it.each(['yes', 'Yeah.', 'Yep!', 'sure', 'okay', 'Yes please', 'I do', 'go ahead'])('agreement only: %s', (t) => {
    expect(classify(t)).toEqual({ kind: 'agree' })
  })

  it.each(['no', 'Nope.', 'never mind', 'Nevermind', 'cancel', 'stop', 'not now', 'no thanks'])('refusal: %s', (t) => {
    expect(classify(t)).toEqual({ kind: 'refuse' })
  })

  it.each(['', 'Recall.', 'hey recall', '...'])('nothing to act on: %j', (t) => {
    expect(classify(t)).toEqual({ kind: 'empty' })
  })

  it('treats a spoken path as words to search, nothing more', () => {
    expect(classify('open C:\\Windows\\System32\\cmd.exe')).toEqual(file('c windows system32 cmd exe'))
  })
})

describe('helpers', () => {
  it('normalizes punctuation and curly apostrophes', () => {
    expect(normalize('  Where’s   my FILE?! ')).toBe("where's my file")
  })
  it('strips only a leading wake word', () => {
    expect(stripWakeWord('recall find recall notes')).toBe('find recall notes')
    expect(stripWakeWord('i cannot recall')).toBe('i cannot recall')
  })
})

describe('stripHeardWakeWord', () => {
  it.each([
    ['Recall.', ''],
    ['We call.', ''],
    ['the call', ''],
    ['Cool', ''],
    ['Re-call, find my resume.', 'Find my resume.'],
    ['Hey Recall, what did I propose to Acme?', 'What did I propose to Acme?'],
    ['We called. Yes.', 'Yes.'],
    ['Uh, we call. Find the dishwasher manual.', 'Find the dishwasher manual.']
  ])('%s → %s', (heard, rest) => expect(stripHeardWakeWord(heard)).toBe(rest))

  it('a lone utterance counts as the wake word only for close mishearings', () => {
    for (const t of ['Recall.', 'We call.', 'The call.', 'Hey, recall!', 're-call']) expect(isHeardWakeWordAlone(t)).toBe(true)
    for (const t of ['Call.', 'Cool.', 'Okay.', 'We call him later.', 'find my resume']) expect(isHeardWakeWordAlone(t)).toBe(false)
  })

  it('leaves text alone when the wake word is not at the start', () => {
    expect(stripHeardWakeWord('find my call notes')).toBe('find my call notes')
    expect(stripHeardWakeWord('Find my resume.')).toBe('Find my resume.')
  })
})

describe('parseOrdinal', () => {
  it.each([
    ['the second one', 2],
    ['Second.', 2],
    ['number three', 3],
    ['number 3', 3],
    ['the 2nd', 2],
    ['option four', 4],
    ['the first one', 1],
    ['the last one', 'last'],
    ['copy the third one please', 3],
    ['yes the second one', 2]
  ])('%s', (t, n) => {
    expect(parseOrdinal(t)).toBe(n)
  })

  it.each(['find my resume', 'the second contract from Acme', 'show in folder', 'never mind'])('not a pick: %s', (t) => {
    expect(parseOrdinal(t)).toBeUndefined()
  })
})

describe('isRevealRequest', () => {
  it.each(['show in folder', 'Open the folder', 'show it in explorer', 'open file explorer', 'reveal location'])('%s', (t) => {
    expect(isRevealRequest(t)).toBe(true)
  })
  it('is not fooled by a file request', () => {
    expect(isRevealRequest('show me the folder with photos')).toBe(false)
  })
})
