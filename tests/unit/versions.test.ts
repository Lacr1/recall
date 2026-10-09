import { describe, expect, it } from 'vitest'
import { compareNames, minhash, nameDates, nameSimilarity, nameStem, sameFamily, similarity } from '../../src/engine/versions'

const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * 7919 + seed * 104729) % 5000}`).join(' ')

describe('version names (S4-04)', () => {
  it('removes version markers, copies and dates', () => {
    expect(nameStem('Acme_Proposal_v3.docx')).toEqual(['acme', 'proposal'])
    expect(nameStem('Copy of Acme Proposal - final (2).pdf')).toEqual(['acme', 'proposal'])
    expect(nameStem('AcmeProposalV2.docx')).toEqual(['acme', 'proposal'])
    expect(nameStem('2026-03-02 Statement of Work rev 4.docx')).toEqual(['statement', 'work'])
    expect(nameStem('contract_20250114_signed.pdf')).toEqual(['contract'])
  })

  it('compares names by shared words', () => {
    expect(nameSimilarity(nameStem('Acme_Proposal_v1.docx'), nameStem('Acme Proposal FINAL.pdf'))).toBe(1)
    expect(nameSimilarity(nameStem('Acme_Proposal.docx'), nameStem('Bluebird_Proposal.docx'))).toBeCloseTo(1 / 3)
    expect(nameSimilarity([], ['x'])).toBe(0)
  })
})

describe('MinHash similarity', () => {
  it('estimates shingle overlap', () => {
    const base = words(400, 1)
    expect(similarity(minhash(base), minhash(base))).toBe(1)
    const edited = base.split(' ').map((w, i) => (i % 50 === 0 ? 'changed' + i : w)).join(' ')
    const s = similarity(minhash(base), minhash(edited))
    expect(s).toBeGreaterThan(0.6)
    expect(s).toBeLessThan(1)
    expect(similarity(minhash(base), minhash(words(400, 2)))).toBeLessThan(0.05)
  })

  it('needs more shared text the less the names agree', () => {
    const same = compareNames('Acme_Proposal_v1.docx', 'Acme_Proposal_v3.docx')
    expect(sameFamily(0.15, same)).toBe(true) // same name, rewritten throughout
    expect(sameFamily(0.05, same)).toBe(false)
    expect(sameFamily(0.3, compareNames('Acme_Proposal.docx', 'Bluebird_Proposal.docx'))).toBe(false) // one template
    expect(sameFamily(0.9, compareNames('notes.txt', 'copy for maya.txt'))).toBe(true) // renamed copy with small edits
  })

  it('treats names that differ only by a date as a series unless much text is shared', () => {
    const dated = compareNames('call-notes-2026-02-18.md', 'call-notes-2025-10-14.md')
    expect(dated).toEqual({ names: 1, datesDiffer: true })
    expect(sameFamily(0.16, dated)).toBe(false) // two meetings' notes from one template
    expect(sameFamily(0.6, dated)).toBe(true) // a dated revision of the same document
    expect(compareNames('Maya_Rate_Card_2025.pdf', 'Maya_Rate_Card_2026.pdf')).toEqual({ names: 1, datesDiffer: true })
    expect(nameDates('Bluebird_SOW_2025-11-02 final (2).pdf')).toEqual(['2025-11-02'])
  })
})
