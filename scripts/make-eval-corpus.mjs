// Generates the Stage 4 retrieval-evaluation corpus in tests/fixtures/eval-corpus and its mtime manifest in
// tests/fixtures/eval-corpus.manifest.json. All names, companies and figures are invented.
// Usage: node scripts/make-eval-corpus.mjs
// Deterministic: no randomness, fixed zip dates, fixed mtimes. Git does not keep mtimes, so the eval harness
// applies them from the manifest after copying the corpus.
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const JSZip = require('jszip') // installed as a dependency of mammoth

let canvasLib = null
try {
  canvasLib = require('@napi-rs/canvas') // optional dependency of pdfjs-dist
} catch {
  console.warn('@napi-rs/canvas is not loadable: OCR images and scanned PDFs are skipped.')
}

const ROOT = path.resolve('tests/fixtures/eval-corpus')
const MANIFEST = path.resolve('tests/fixtures/eval-corpus.manifest.json')
const ZIP_DATE = new Date('2024-01-01T00:00:00Z')

/** rel -> { data: Buffer, date: string, text: string | null } */
const files = new Map()
const families = []
const duplicates = []
const distractors = []

function add(rel, date, data, text) {
  if (files.has(rel)) throw new Error(`Duplicate path ${rel}`)
  files.set(rel, { data, date, text })
}

function toDate(d) {
  return new Date(d.length === 10 ? `${d}T10:00:00Z` : `${d}:00Z`)
}

// ---------- minimal PDF writer (Helvetica, ASCII text; copied from make-fixtures.mjs) ----------
function wrap(text, width = 88) {
  const out = []
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width) {
        out.push(line.trim())
        line = word
      } else line += ' ' + word
    }
    out.push(line.trim())
  }
  return out
}

const pdfEsc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

function assemblePdf(objs, pageIds, title) {
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const infoId = objs.length
  objs[infoId] = `<< /Title (${pdfEsc(title)}) /Producer (Recall eval fixtures) >>`
  let out = '%PDF-1.4\n'
  const offsets = []
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = Buffer.byteLength(out, 'latin1')
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** Text PDF. Headings ("# ", "## ") lose their markers; "\f" forces a page break; long pages split at 50 lines. */
function pdf(text, title) {
  const pages = []
  for (const part of text.split('\f')) {
    const lines = wrap(part.replace(/^#+ /gm, '').trim())
    for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50))
  }
  const objs = []
  const pageIds = []
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  let next = 4
  for (const lines of pages) {
    const stream = 'BT /F1 11 Tf 14 TL 72 760 Td\n' + lines.map((l) => `(${pdfEsc(l)}) Tj T*`).join('\n') + '\nET'
    const contentId = next++
    const pageId = next++
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    pageIds.push(pageId)
  }
  return assemblePdf(objs, pageIds, title)
}

/** Image-only PDF, like a scan: one JPEG per page, no text layer. */
function pdfFromImages(images, title) {
  const objs = []
  const pageIds = []
  let next = 3
  for (const { jpeg, width, height } of images) {
    const imgId = next++
    const contentId = next++
    const pageId = next++
    objs[imgId] =
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n` +
      jpeg.toString('latin1') +
      '\nendstream'
    const s = Math.min(540 / width, 720 / height)
    const w = Math.round(width * s)
    const h = Math.round(height * s)
    const stream = `q ${w} 0 0 ${h} ${Math.round((612 - w) / 2)} ${792 - 36 - h} cm /Im1 Do Q`
    objs[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /XObject << /Im1 ${imgId} 0 R >> >> >>`
    pageIds.push(pageId)
  }
  return assemblePdf(objs, pageIds, title)
}

// ---------- minimal DOCX writer (copied from make-fixtures.mjs, with fixed zip dates) ----------
async function docx(text, title) {
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const m = /^(#{1,3}) (.*)$/.exec(l)
      return m
        ? `<w:p><w:pPr><w:pStyle w:val="Heading${m[1].length}"/></w:pPr><w:r><w:t>${x(m[2])}</w:t></w:r></w:p>`
        : `<w:p><w:r><w:t xml:space="preserve">${x(l)}</w:t></w:r></w:p>`
    })
    .join('')
  const zip = new JSZip()
  // Folder entries would carry the current time, so they are not created.
  const put = (name, content) => zip.file(name, content, { date: ZIP_DATE, createFolders: false })
  put(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
  )
  put(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
  )
  put(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  )
  put(
    'word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join('') +
      '</w:styles>'
  )
  put(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(title)}</dc:title></cp:coreProperties>`
  )
  put(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

// ---------- image rendering for OCR fixtures ----------
/** Renders lines of text onto a light background. A line is a string or { text, size, bold, font, align }. */
function renderImage({ width, lines, font = 'Arial', size = 32, bg = '#f7f5ef', fg = '#1c1c1c', pad = 56, gap = 1.5, format = 'png', rule }) {
  const { createCanvas } = canvasLib
  const heights = lines.map((l) => Math.round(((typeof l === 'object' && l.size) || size) * gap))
  const height = pad * 2 + heights.reduce((a, b) => a + b, 0)
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, width, height)
  if (rule) {
    // Faint ruled lines, like lined paper.
    ctx.strokeStyle = rule
    ctx.lineWidth = 1
    for (let y = pad + heights[0]; y < height; y += heights[0]) {
      ctx.beginPath()
      ctx.moveTo(0, y + 4)
      ctx.lineTo(width, y + 4)
      ctx.stroke()
    }
  }
  ctx.fillStyle = fg
  ctx.textBaseline = 'top'
  let y = pad
  lines.forEach((l, i) => {
    const item = typeof l === 'string' ? { text: l } : l
    ctx.font = `${item.bold ? 'bold ' : ''}${item.size ?? size}px "${item.font ?? font}"`
    const w = ctx.measureText(item.text).width
    const x = item.align === 'center' ? (width - w) / 2 : item.align === 'right' ? width - pad - w : pad
    ctx.fillText(item.text, x, y)
    y += heights[i]
  })
  const buf = format === 'jpeg' ? c.toBuffer('image/jpeg', 90) : c.toBuffer('image/png')
  return { buf, width, height }
}

/** Monospace receipt row: left text, right-aligned amount. */
const row = (left, right, w = 32) => left + ' '.repeat(Math.max(1, w - left.length - right.length)) + right

// ---------- file helpers ----------
const txt = (rel, date, text) => add(rel, date, Buffer.from(text, 'utf8'), text)
const pdfFile = (rel, date, title, text) => add(rel, date, pdf(text, title), text)
const docxFile = async (rel, date, title, text) => add(rel, date, await docx(text, title), text)
/** Exact byte copy of another corpus file in a different place. */
function copyOf(rel, date, fromRel) {
  const src = files.get(fromRel)
  if (!src) throw new Error(`copyOf: ${fromRel} not generated yet`)
  add(rel, date, src.data, src.text)
  const set = duplicates.find((d) => d.includes(fromRel))
  if (set) set.push(rel)
  else duplicates.push([fromRel, rel])
}
const family = (name, members) => families.push({ name, members })
const slug = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const distractor = (a, b, note) => distractors.push({ a, b, note })


// =====================================================================================================
// Persona 1: Maya Lindqvist Consulting (freelance service and product designer, Uppsala)
// =====================================================================================================

const MAYA_ABOUT = `## About Maya Lindqvist Consulting
Maya Lindqvist Consulting is a one-person product and service design practice based in Uppsala, Sweden. I help small and mid-sized organisations improve the booking, ordering and customer communication flows that their business depends on. Every engagement is led and delivered by me, with trusted specialists brought in for visual design or development when needed.

## How I work
Each project starts with a short discovery phase: interviews with staff and customers, a review of existing data and a walkthrough of the current tools. From there I sketch options, test them with real users and deliver working changes in small increments, so you see progress every two weeks. You get a shared project board, a written summary after every workshop and a fortnightly status note.`

const MAYA_TAIL = `## Assumptions
- You nominate one decision maker who can approve designs within five working days.
- You provide access to analytics, the current system and the relevant staff.
- Travel within Sweden is included. Travel outside Sweden is billed at cost.
- Prices are in euro and exclude VAT.

## Next steps
If this proposal looks right, reply to confirm and I will send a services agreement for signature. This proposal is valid for 30 days from the date above.

Maya Lindqvist
maya@lindqvist-consulting.se | +46 70 214 88 31`

function mayaProposal({ title, client, date, version, summary, scope, fees, timeline, warranty, extra = '' }) {
  return `# ${title}
Prepared for ${client} by Maya Lindqvist Consulting
${version ? `Version: ${version}\n` : ''}Date: ${date}

## Summary
${summary}

${MAYA_ABOUT}

## Scope
${scope}

## Fees and payment
${fees}

## Timeline
${timeline}

## Warranty
${warranty}

${MAYA_TAIL}
${extra}`.trim() + '\n'
}

// ---------- Acme Outdoor Co. (booking system redesign) ----------
const ACME = 'clients/acme-outdoor'
const acmeSummary = `Acme Outdoor Co. runs guided hiking and kayaking trips in Jamtland and the Stockholm archipelago. The current booking system was built in 2017, does not show live availability and regularly double-books guides when two customers check out at the same time. This proposal covers a redesign of the online booking system: availability search, bookings for groups, checkout and confirmation emails.`

function acmeProposal(v) {
  const scope = {
    1: 'Discovery workshops with the operations team, a new availability calendar, a simplified checkout and an admin view for trip leaders.',
    2: 'Discovery workshops with the operations team, a new availability calendar, a simplified checkout, an admin view for trip leaders and a waitlist for sold-out trips.',
    3: 'Discovery workshops with the operations team, a new availability calendar, a simplified checkout, an admin view for trip leaders, a waitlist for sold-out trips and group bookings for up to 12 people in one order.',
    4: 'Discovery workshops with the operations team, a new availability calendar, a simplified checkout, an admin view for trip leaders, a waitlist for sold-out trips, group bookings for up to 12 people in one order and selection of a pickup point at checkout.'
  }[v]
  const fees = {
    1: 'The total fee is EUR 24,000, invoiced monthly in arrears over the three month engagement (EUR 8,000 per month).',
    2: 'The total fee is EUR 26,000. We propose a 50% initial payment upon signing (EUR 13,000), with the remaining 50% due on completion of the project.',
    3: 'The total fee is EUR 26,000. After our call on 18 February the structure changed: 40% upfront on signing (EUR 10,400), then two payment milestones of 30% each (EUR 7,800). The first milestone is invoiced when the new availability calendar goes live, the second at final handover.',
    4: 'The total fee is EUR 26,000. Payment is 40% upfront on signing (EUR 10,400), then two payment milestones of 30% each (EUR 7,800). The first milestone is invoiced when the new availability calendar goes live, the second at final handover.'
  }[v]
  const timeline = {
    1: 'Work starts on 2 February and finishes on 30 April 2026.',
    2: 'Work starts on 2 March and finishes on 29 May 2026.',
    3: 'Work starts on 9 March 2026. Milestone one: availability calendar live by 17 April. Milestone two: handover by 29 May.',
    4: 'Work starts on 9 March 2026. Milestone one: availability calendar live by 17 April. Milestone two: handover by 29 May.'
  }[v]
  const warranty = { 1: 30, 2: 60, 3: 90, 4: 90 }[v]
  return mayaProposal({
    title: 'Acme Booking System Redesign - Proposal',
    client: 'Acme Outdoor Co.',
    date: { 1: '12 January 2026', 2: '3 February 2026', 3: '20 February 2026', 4: '1 March 2026' }[v],
    version: { 1: '1', 2: '2', 3: '3', 4: '3 (final)' }[v],
    summary: acmeSummary,
    scope,
    fees,
    timeline,
    warranty: `Defects reported within ${warranty} days of launch are fixed at no extra cost.`,
    extra: v === 4 ? '\n## Acceptance\nAccepted on behalf of Acme Outdoor Co. by Jonas Berg, Head of Operations, on 1 March 2026.' : ''
  })
}

await docxFile(`${ACME}/proposals/Acme_Proposal_v1.docx`, '2026-01-12', 'Acme Booking Proposal v1', acmeProposal(1))
pdfFile(`${ACME}/proposals/Acme_Proposal_v2.pdf`, '2026-02-03', 'Acme Booking Proposal v2', acmeProposal(2))
await docxFile(`${ACME}/proposals/Acme_Proposal_v3.docx`, '2026-02-20', 'Acme Booking Proposal v3', acmeProposal(3))
await docxFile(`${ACME}/proposals/Acme_Proposal_v3 - final.docx`, '2026-03-01', 'Acme Booking Proposal v3 final', acmeProposal(4))
copyOf('Downloads/Acme_Proposal_v3 (1).docx', '2026-02-21', `${ACME}/proposals/Acme_Proposal_v3.docx`)
family('Acme booking proposal', [
  `${ACME}/proposals/Acme_Proposal_v1.docx`,
  `${ACME}/proposals/Acme_Proposal_v2.pdf`,
  `${ACME}/proposals/Acme_Proposal_v3.docx`,
  `${ACME}/proposals/Acme_Proposal_v3 - final.docx`
])

function acmeAgreement(v) {
  const draft = v === 1
  const signed = v === 3
  return `# Services Agreement
${draft ? 'DRAFT for discussion - 26 February 2026' : signed ? 'Executed version - 10 March 2026' : 'Revised draft v2 - 5 March 2026'}

This agreement is made between Maya Lindqvist Consulting, org. no. 870412-4417, Uppsala ("the Consultant") and Acme Outdoor Co. AB, org. no. 556901-2234, Ostersund ("the Client").

## 1. Services
The Consultant will deliver the booking system redesign described in the proposal version 3 dated 20 February 2026, which is attached as Appendix A. Changes to the scope are agreed in writing by both parties before work on them starts.

## 2. Fees and payment
The total fee is EUR 26,000 excluding VAT, invoiced as 40% on signing, 30% when the availability calendar goes live and 30% at final handover. Invoices are payable within ${draft ? '30' : '20'} days of the invoice date.${signed ? ' Late payments carry interest at 8 percentage points above the Swedish reference rate.' : ''}

## 3. Intellectual property
All designs, code and documents created specifically for the Client transfer to the Client upon full payment. The Consultant keeps the right to reuse general know-how, methods and components that are not specific to the Client.

## 4. Confidentiality
Each party keeps the other party's confidential information secret during the agreement and for three years after it ends.

## 5. Liability
${draft ? "Each party's total liability under this agreement is capped at the fees paid in the six months before the claim arose." : "Each party's total liability under this agreement is capped at the total fee of EUR 26,000."} Neither party is liable for indirect losses such as lost profit or lost bookings.

## 6. Termination
Either party may terminate this agreement with ${draft ? '30' : '45'} days written notice.${draft ? '' : ' Work completed up to the termination date is invoiced pro rata.'}
${draft ? '' : '\n## 7. Personal data\nThe Consultant processes customer booking data only as a processor on behalf of the Client, under the data processing agreement attached as Appendix B.\n'}
## ${draft ? '7' : '8'}. Governing law
This agreement is governed by Swedish law. Disputes are settled by the Uppsala District Court.
${signed ? '\n## Signatures\nSigned for Maya Lindqvist Consulting: Maya Lindqvist, 9 March 2026.\nSigned for Acme Outdoor Co. AB: Jonas Berg, Head of Operations, 10 March 2026.' : ''}`.trim() + '\n'
}

await docxFile(`${ACME}/contract/Acme_Services_Agreement_draft.docx`, '2026-02-26', 'Acme Services Agreement draft', acmeAgreement(1))
await docxFile(`${ACME}/contract/Acme_Services_Agreement_v2.docx`, '2026-03-05', 'Acme Services Agreement v2', acmeAgreement(2))
pdfFile(`${ACME}/contract/Acme_Services_Agreement - signed.pdf`, '2026-03-10', 'Acme Services Agreement signed', acmeAgreement(3))
family('Acme services agreement', [
  `${ACME}/contract/Acme_Services_Agreement_draft.docx`,
  `${ACME}/contract/Acme_Services_Agreement_v2.docx`,
  `${ACME}/contract/Acme_Services_Agreement - signed.pdf`
])

function callNotes({ client, date, attendees, sections, actions }) {
  return `# Client call - ${client} (${date})

Attendees: ${attendees}
Format: video call, 45 minutes

## Agenda
1. Check-in and updates since the last call
2. Payment and commercial questions
3. Scope and priorities
4. Decisions and next steps

${sections.map(([h, body]) => `## ${h}\n${body}`).join('\n\n')}

## Action items
${actions.map((a) => `- [ ] ${a}`).join('\n')}

## Next call
To be scheduled by Maya within two weeks.

Notes taken by Maya Lindqvist and shared with all attendees after the call. Please reply within two working days if anything is wrong or missing.
`
}

txt(
  `${ACME}/call-notes-2026-02-18.md`,
  '2026-02-18',
  callNotes({
    client: 'Acme Outdoor',
    date: '18 Feb 2026',
    attendees: 'Maya, Jonas Berg (Acme operations), Priya Nair (Acme finance)',
    sections: [
      ['Payment', 'Priya said a 50% deposit is too much for their cash flow this quarter because the winter season was weak. We agreed to move to 40% upfront and split the rest into two milestones. I will send a revised proposal (v3).'],
      ['Booking system', 'Jonas wants bookings for groups of up to 12 people in one order, and a waitlist when trips sell out. The current system double-books guides when two people check out at the same moment. Gift cards came up again.'],
      ['Decisions', 'Payment structure changes to 40 / 30 / 30. Waitlist and group bookings are in scope; gift cards are out of scope for this phase.']
    ],
    actions: ['Maya: send proposal v3 by 20 Feb', 'Priya: confirm the invoice address and PO number', 'Jonas: export last season booking data as CSV']
  })
)

txt(
  `${ACME}/call-notes-2026-03-16.md`,
  '2026-03-16',
  callNotes({
    client: 'Acme Outdoor',
    date: '16 Mar 2026',
    attendees: 'Maya, Jonas Berg (Acme operations), Elsa Holm (lead guide)',
    sections: [
      ['Progress', 'The availability calendar prototype was tested with five customers last week. Four of five found a kayaking date in under a minute. Milestone one (calendar live by 17 April) is on track.'],
      ['Double bookings', 'Elsa showed two cases from last weekend where the same guide was assigned to two trips. Root cause is the old checkout not holding seats. We agreed that a seat is held for 10 minutes while the customer pays, then released.'],
      ['Pickup points', 'Customers keep phoning to ask where the bus leaves from. Jonas wants a pickup point choice at checkout: Ostersund station, Are square or the hotel.']
    ],
    actions: ['Maya: write the hold-and-release rule into the spec for Tidewater', 'Elsa: list the pickup points with GPS coordinates', 'Jonas: book the milestone demo for 15 April']
  })
)

txt(
  `${ACME}/Acme_kickoff_workshop_agenda.md`,
  '2026-03-09',
  `# Acme booking redesign - kickoff workshop
Date: Monday 9 March 2026, 09:30-15:00
Place: Acme office, Storgatan 14, Ostersund

## Agenda
09:30 Welcome and goals for the season (Jonas)
10:00 How customers book today: walkthrough of the old system
10:45 Pain points from guides and the phone team (sticky notes)
12:00 Lunch
13:00 Sketching the new availability calendar
14:15 Group bookings and the waitlist: rules and edge cases
14:45 Agree milestones and the demo date

## Bring
Last season's booking export, the list of trips for summer 2026, examples of customer complaints.
`
)

txt(
  `${ACME}/status-2026-04-07.md`,
  '2026-04-07',
  `# Weekly status - Acme booking redesign
Week 15, 7 April 2026. Status: green

## Done this week
- Availability calendar connected to the live trip database.
- Seat hold of 10 minutes implemented by Tidewater and tested with 40 parallel checkouts.
- Copy for the waitlist emails approved by Jonas.

## Next week
- Milestone demo on 15 April.
- Start group booking flow (up to 12 people).

## Risks
- The payment provider sandbox was down for two days; no impact on the date yet.

## Budget
EUR 10,400 invoiced of EUR 26,000.

Status colours: green means on track, amber means at risk but recoverable, red means a decision from the client is needed. Reply to this note with questions; the next status note follows in one week.
`
)

txt(
  `${ACME}/Acme_milestone1_acceptance.txt`,
  '2026-04-17',
  `MILESTONE ACCEPTANCE - Acme Outdoor Co.
Project: Booking system redesign
Milestone: 1 - availability calendar live
Date: 17 April 2026

The availability calendar went live on acme-outdoor.se on 16 April 2026 at 21:00. Customers can see open spots for every trip for the next 18 months, filter by region and difficulty, and join a waitlist for full trips.

Accepted by: Jonas Berg, Head of Operations
The Consultant may now invoice milestone 1 (30%, EUR 7,800).
`
)

// ---------- Bluebird Dental Clinics (patient reminder service) ----------
const BLUE = 'clients/bluebird-dental'
function bluebirdSow(v) {
  const final = v === 3
  return `# Statement of Work - Patient Reminder Service
Client: Bluebird Dental Clinics AB
Supplier: Maya Lindqvist Consulting
Date: ${{ 1: '20 October 2025', 2: '2 November 2025', 3: '2 November 2025 (final)' }[v]}

## Background
Bluebird Dental Clinics operates four clinics in Uppsala and Enkoping. About 18% of booked appointments are missed without notice, which costs the clinics an estimated EUR 210,000 a year in idle chair time.

## Service
A patient reminder service that sends reminders ${v === 1 ? '24 hours' : '48 hours'} before each appointment by SMS and email, with a link to confirm or cancel.${final ? ' A second, SMS-only reminder is sent 2 hours before the appointment.' : ''}

## Deliverables
- A reminder scheduler connected to the clinics' DentaBook booking system.
- Message templates ${v === 1 ? 'in English' : 'in English and Swedish'}.
- An opt-out page for patients who do not want reminders.
${v === 1 ? '' : '- A monthly report of no-show rates per clinic.\n'}- Handover documentation and one training session for reception staff.

## Roles and responsibilities
Bluebird provides API access to DentaBook, a test clinic and one contact person in each clinic. The Supplier designs, builds and configures the service and supports reception staff during the first two weeks.

## Commercial terms
${v === 1 ? 'Fixed price of EUR 9,000, payable 30% on kickoff and 70% on acceptance. Support after go-live is billed at EUR 90 per hour.' : 'Fixed price of EUR 9,500, payable in two equal instalments: half on kickoff and half on acceptance. Support after go-live is billed at EUR 95 per hour.'} SMS costs are passed through at cost.

## Acceptance
${final ? 'The Client confirms acceptance within 10 business days of go-live. If the Client raises no defects in that period, the service counts as accepted.' : 'The Client tests the service for two weeks after go-live and then confirms acceptance in writing.'}

## Data protection
Patient names, phone numbers and appointment times are processed under the data processing agreement signed on 28 October 2025.${final ? ' Message logs are deleted after 90 days.' : ''}

## Timeline
Kickoff on 10 November 2025. Go-live ${v === 1 ? 'on 15 December 2025' : 'on 12 January 2026'}.

## Change requests
Changes to scope are estimated in hours and approved by email before work starts.
`
}
await docxFile(`${BLUE}/Bluebird_SOW_2025-10-20.docx`, '2025-10-20', 'Bluebird SOW', bluebirdSow(1))
await docxFile(`${BLUE}/Bluebird_SOW_2025-11-02.docx`, '2025-11-02', 'Bluebird SOW', bluebirdSow(2))
pdfFile(`${BLUE}/Bluebird_SOW_2025-11-02 final (2).pdf`, '2025-11-04', 'Bluebird SOW final', bluebirdSow(3))
copyOf(`${BLUE}/signed/Bluebird_SOW_2025-11-02 final (2).pdf`, '2025-11-06', `${BLUE}/Bluebird_SOW_2025-11-02 final (2).pdf`)
family('Bluebird statement of work', [
  `${BLUE}/Bluebird_SOW_2025-10-20.docx`,
  `${BLUE}/Bluebird_SOW_2025-11-02.docx`,
  `${BLUE}/Bluebird_SOW_2025-11-02 final (2).pdf`
])

txt(
  `${BLUE}/call-notes-2025-10-14.md`,
  '2025-10-14',
  callNotes({
    client: 'Bluebird Dental',
    date: '14 Oct 2025',
    attendees: 'Maya, Dr. Elin Sandberg (owner), Tomas Ek (IT)',
    sections: [
      ['Payment', 'Elin is fine with a fixed price but wants most of it paid after the service works. We discussed 30% on kickoff and 70% on acceptance.'],
      ['Reminders', 'About 18% of appointments are no-shows, worst on Monday mornings and for hygienist visits. Elin wants reminders by SMS and email. Many older patients only read Swedish, so templates must exist in Swedish too.'],
      ['Decisions', 'Start with SMS and email; WhatsApp is out of scope. Tomas will check whether DentaBook has an API for appointment exports.']
    ],
    actions: ['Maya: draft the statement of work by 20 Oct', 'Tomas: ask DentaBook support about API keys', 'Elin: send the no-show numbers per clinic for 2025']
  })
)

txt(
  `${BLUE}/call-notes-2026-01-22.md`,
  '2026-01-22',
  callNotes({
    client: 'Bluebird Dental',
    date: '22 Jan 2026',
    attendees: 'Maya, Dr. Elin Sandberg (owner), Sara Lind (reception, Enkoping)',
    sections: [
      ['Results', 'Ten days after go-live the no-show rate dropped from 18% to 11%. Reception staff spend less time phoning patients.'],
      ['Feedback', 'Some patients reply to the SMS with free text ("can I come Thursday instead?"), which nobody reads. Sara asked for a rebooking link inside the reminder.'],
      ['Phase 2', 'Elin wants freed slots filled automatically from a cancellation list. I will send a phase 2 proposal in March.']
    ],
    actions: ['Maya: phase 2 proposal by end of March', 'Sara: collect ten real SMS replies as examples', 'Elin: approve the acceptance of phase 1']
  })
)

txt(
  `${BLUE}/no-show-report-2026-02.md`,
  '2026-03-03',
  `# No-show report - February 2026
Bluebird Dental Clinics, all four clinics

| Clinic | Appointments | No-shows | Rate |
|---|---|---|---|
| Uppsala Centrum | 168 | 17 | 10.1% |
| Uppsala Gottsunda | 104 | 13 | 12.5% |
| Enkoping | 87 | 10 | 11.5% |
| Enkoping Vast | 53 | 6 | 11.3% |
| Total | 412 | 46 | 11.2% |

SMS delivery rate: 98.6%. Email open rate: 61%.
Patients who opted out of reminders: 23.
The highest no-show rate is still Monday 08:00-10:00 at Gottsunda.
`
)

await docxFile(
  `${BLUE}/Bluebird_Phase2_Proposal.docx`,
  '2026-03-24',
  'Bluebird Phase 2 Proposal',
  mayaProposal({
    title: 'Bluebird Reminders Phase 2 - Proposal',
    client: 'Bluebird Dental Clinics',
    date: '24 March 2026',
    summary: 'Phase 1 of the patient reminder service brought the no-show rate down from 18% to 11%. Phase 2 makes it easy for patients to move an appointment instead of skipping it, and fills freed slots from a cancellation list so chairs are not left empty.',
    scope: 'A rebooking link inside every reminder SMS, a cancellation list that patients can join for earlier appointments, automatic offers to the next patient on the list when a slot is freed, and an updated monthly report.',
    fees: 'The total fee is EUR 6,400, paid 50% on signing and 50% on launch.',
    timeline: 'Work runs from 13 April to 29 May 2026.',
    warranty: 'Defects reported within 60 days of launch are fixed at no extra cost.'
  })
)

// ---------- Harbor & Pine Hotels (guest messaging) ----------
const HP = 'clients/harbor-pine-hotels'
function harborProposal(v) {
  return mayaProposal({
    title: 'Pre-arrival Guest Journey - Proposal',
    client: 'Harbor & Pine Hotels',
    date: { 1: '6 May 2025', 2: '14 May 2025', 3: '21 May 2025' }[v],
    summary: 'Harbor & Pine Hotels runs three boutique hotels in Visby, Kalmar and Ystad with 128 rooms in total. Guests receive one generic confirmation email, and the front desk spends about two hours a day answering the same questions about parking, check-in times and breakfast. This proposal covers a pre-arrival guest journey: a personalised email seven days before arrival, a mobile check-in form and relevant offers.',
    scope:
      v === 1
        ? 'Pre-arrival email journey in Swedish, English and German, a mobile check-in form, and upsell offers for breakfast, spa treatments and late checkout.'
        : 'Pre-arrival email journey in Swedish, English and German, a mobile check-in form, and upsell offers for breakfast, room upgrades and late checkout. Spa booking is left out because the spa system has no API.',
    fees:
      v === 1
        ? 'The total fee is EUR 18,000, payable in three equal instalments of EUR 6,000.'
        : v === 2
          ? 'The total fee is EUR 16,500, payable in three equal instalments of EUR 5,500.'
          : 'The total fee is EUR 16,500, payable 30% on signing (EUR 4,950), 40% when the email journey is live in the first hotel (EUR 6,600) and 30% at handover (EUR 4,950).',
    timeline: v === 3 ? 'Work runs from July to September 2025, after the peak of the high season, starting in Visby.' : 'Work runs from June to August 2025, starting in Visby.',
    warranty: `Defects reported within ${v === 3 ? 45 : 30} days of launch are fixed at no extra cost.`
  })
}
await docxFile(`${HP}/Harbor_Pine_Proposal.docx`, '2025-05-06', 'Harbor & Pine proposal', harborProposal(1))
await docxFile(`${HP}/Harbor_Pine_Proposal (1).docx`, '2025-05-14', 'Harbor & Pine proposal', harborProposal(2))
await docxFile(`${HP}/Harbor_Pine_Proposal - final.docx`, '2025-05-21', 'Harbor & Pine proposal final', harborProposal(3))
family('Harbor & Pine proposal', [`${HP}/Harbor_Pine_Proposal.docx`, `${HP}/Harbor_Pine_Proposal (1).docx`, `${HP}/Harbor_Pine_Proposal - final.docx`])

txt(
  `${HP}/kickoff-notes-2025-07-02.md`,
  '2025-07-02',
  `# Harbor & Pine - kickoff in Visby (2 July 2025)

Present: Maya, Lucia Moreno (general manager), Anders Wik (front desk lead), Mira Falk (marketing)

- Top three guest questions: where to park (the hotel has 14 spaces, first come first served), check-in time (15:00), and whether breakfast can be packed for the early ferry.
- Lucia wants the pre-arrival email to promote the ferry breakfast box (SEK 145) and late checkout until 14:00 (SEK 300).
- Room upgrades only when occupancy is under 80%, otherwise do not offer them.
- German guests are about a quarter of summer bookings in Visby, so German copy is a must.
- Anders worries guests will ignore a long email. Keep it short, one offer per email.
`
)

// ---------- Kestrel Bakery Co-op (click and collect) ----------
await docxFile(
  'clients/kestrel-bakery/Kestrel_Bakery_Proposal.docx',
  '2025-09-03',
  'Kestrel Bakery proposal',
  mayaProposal({
    title: 'Online Pre-orders and Click & Collect - Proposal',
    client: 'Kestrel Bakery Co-op',
    date: '3 September 2025',
    summary: 'Kestrel Bakery Co-op runs two shops in Uppsala, Svartbacken and Luthagen. On Saturday mornings the queue reaches the street, and about 15% of the bread baked each day is thrown away or given to the food bank. This proposal covers online pre-orders so customers can reserve bread the evening before and bakers know how much to bake.',
    scope: 'Online pre-orders until 20:00 for pickup the next morning, a click-and-collect shelf in each shop, a daily bake list for the bakers generated at 20:15, and a simple stock page for the shop staff.',
    fees: 'The total fee is EUR 7,200, paid 50% on signing and 50% on launch.',
    timeline: 'Work runs from 15 September to 31 October 2025, with Luthagen going live first.',
    warranty: 'Defects reported within 30 days of launch are fixed at no extra cost.'
  })
)
distractor(`${HP}/Harbor_Pine_Proposal - final.docx`, 'clients/kestrel-bakery/Kestrel_Bakery_Proposal.docx', 'same proposal template, different client, scope and price')

txt(
  'clients/kestrel-bakery/call-notes-2025-08-28.md',
  '2025-08-28',
  callNotes({
    client: 'Kestrel Bakery',
    date: '28 Aug 2025',
    attendees: 'Maya, Johan Pettersson (head baker), Linnea Ahl (shop manager)',
    sections: [
      ['Payment', 'The co-op board must approve anything above EUR 8,000, so we keep the price under that and pay half up front.'],
      ['Ordering', 'Sourdough rye and cardamom buns sell out by 10:00 on Saturdays. Johan bakes at 04:00 and needs the order list by the evening before. Customers should pick a pickup window, 07:00-09:00 or 09:00-12:00.'],
      ['Decisions', 'No delivery. Payment online at the time of ordering so nobody forgets to collect.']
    ],
    actions: ['Maya: proposal by 3 Sep', 'Linnea: measure the shelf space by the door in both shops', 'Johan: list of products that can be pre-ordered']
  })
)
distractor(`${ACME}/call-notes-2026-02-18.md`, `${BLUE}/call-notes-2025-10-14.md`, 'same call-notes template, different client and decisions')

// ---------- Consulting agreement template: Fernhill Library Trust and Larkspur Architects ----------
function consultingContract({ client, clientDesc, date, assignment, term, fees, expenses, law, version }) {
  return `# Consulting Agreement
${version ? `Version ${version} - ` : ''}${date}

Between ${client}, ${clientDesc} ("the Client"), and Maya Lindqvist Consulting, Uppsala, Sweden ("the Consultant").

## 1. Assignment
${assignment}

## 2. Term
${term}

## 3. Fees
${fees} The Consultant invoices monthly on the basis of timesheets approved by the Client. Invoices are payable within 30 days.

## 4. Expenses
${expenses}

## 5. Confidentiality
The Consultant keeps all non-public information about the Client confidential, during and after the assignment.

## 6. Intellectual property
Reports, designs and other work results produced under this agreement belong to the Client once paid for.

## 7. Termination
Either party may end the agreement with 14 days written notice. Days worked up to the end date are invoiced.

## 8. Governing law
${law}

Signed for the Client: ______________________   Signed for the Consultant: ______________________
`
}
function fernhillContract(v) {
  return consultingContract({
    client: 'Fernhill Library Trust',
    clientDesc: 'a charitable trust running nine public libraries in County Wicklow, Ireland',
    version: String(v),
    date: v === 1 ? '2 September 2024' : '16 September 2024',
    assignment: 'The Consultant advises the Client on the migration of its library catalogue (approximately 186,000 records) from the legacy LibraSys system to OpenShelf, including a data cleaning plan, training for branch staff and a review of the public search interface.',
    term: v === 1 ? 'From 2 September 2024 to 28 February 2025.' : 'From 16 September 2024 to 31 March 2025.',
    fees: v === 1 ? 'A day rate of EUR 720 excluding VAT, for up to 40 days.' : 'A day rate of EUR 680 excluding VAT, for up to 45 days.',
    expenses: v === 1 ? 'Reasonable travel expenses are reimbursed at cost.' : 'Reasonable travel expenses are reimbursed at cost, capped at EUR 1,500 for the whole term.',
    law: 'This agreement is governed by the laws of Ireland.'
  })
}
pdfFile('clients/fernhill-library/Fernhill_Consulting_Contract_v1.pdf', '2024-09-02', 'Fernhill contract v1', fernhillContract(1))
pdfFile('clients/fernhill-library/Fernhill_Consulting_Contract_v2.pdf', '2024-09-16', 'Fernhill contract v2', fernhillContract(2))
family('Fernhill consulting contract', ['clients/fernhill-library/Fernhill_Consulting_Contract_v1.pdf', 'clients/fernhill-library/Fernhill_Consulting_Contract_v2.pdf'])

pdfFile(
  'clients/larkspur-architects/Larkspur_Consulting_Contract.pdf',
  '2025-02-10',
  'Larkspur contract',
  consultingContract({
    client: 'Larkspur Architects AB',
    clientDesc: 'an architecture practice in Gothenburg, Sweden',
    date: '10 February 2025',
    assignment: 'The Consultant designs a searchable archive for 22 years of project drawings, CAD files and planning permissions, including a tagging scheme, a search prototype and guidelines for naming new project folders.',
    term: 'From 3 March 2025 to 30 May 2025.',
    fees: 'A day rate of EUR 750 excluding VAT, for up to 20 days.',
    expenses: 'Travel between Uppsala and Gothenburg is reimbursed at the cost of a second class train ticket.',
    law: 'This agreement is governed by Swedish law.'
  })
)
distractor('clients/fernhill-library/Fernhill_Consulting_Contract_v2.pdf', 'clients/larkspur-architects/Larkspur_Consulting_Contract.pdf', 'same consulting agreement template, different client, rate and assignment')

txt(
  'clients/larkspur-architects/archive-workshop-notes.md',
  '2025-03-20',
  `# Larkspur archive workshop (20 March 2025)

- The drawing archive sits on a file server: 1.9 million files, 22 years, about 6 TB.
- Architects search by project number (e.g. P-2011-044) but nobody remembers numbers older than five years. They remember the street, the client or what the building looked like.
- Agreed tags: project number, address, client, building type, phase (competition, permit, construction), year.
- Planning permissions are scanned PDFs without text. OCR them first.
- Naming rule for new folders: P-year-number_short-street-name, e.g. P-2025-012_Masthuggsgatan.
`
)

txt(
  'clients/fernhill-library/catalogue-migration-notes.md',
  '2024-11-05',
  `# Fernhill catalogue migration - working notes

- Export from LibraSys finished: 186,412 records in MARC21.
- About 4% of records have duplicate ISBNs, mostly large print and audiobook editions catalogued as the same item.
- 2,300 records have no subject headings at all; branch staff added local notes in the wrong field.
- OpenShelf import accepts MARC but drops field 590 (local notes). Plan: map 590 to a custom "branch note" field.
- Bray and Greystones branches want to keep their local history collections searchable separately.
- Test import of 10,000 records took 11 minutes.
- Training plan: two half-day sessions per branch in January, recorded for part-time staff.
`
)

pdfFile(
  'clients/fernhill-library/Fernhill_final_report.pdf',
  '2025-03-28',
  'Fernhill final report',
  `# Fernhill Library Trust - Catalogue Migration Final Report
March 2025

## Outcome
All 186,412 catalogue records were migrated to OpenShelf on 24 February 2025 with no downtime for borrowers. Duplicate ISBN records were reduced from 4% to 0.3% by merging editions under one work record.

## Search
Search success in the public catalogue, measured as searches followed by a reservation or a shelf-mark view, rose from 38% to 57% in the first four weeks.

## Training
146 staff across nine branches attended training. A recorded version and a two-page quick guide are available on the staff intranet.

## Open items
Local history collections in Bray and Greystones still need subject headings. Estimated effort: 6 days.

## Days used
41 of 45 contracted days.
`
)

// ---------- Orchid Logistics (warehouse KPI dashboards) ----------
const ORC = 'clients/orchid-logistics'
function orchidSow(v) {
  return `# Statement of Work - Warehouse KPI Dashboards
Client: Orchid Logistics AB, Norrkoping
Supplier: Maya Lindqvist Consulting
Date: ${{ 1: '2 June 2025', 2: '11 June 2025', 3: '19 June 2025' }[v]}

## Background
Orchid Logistics runs three third-party warehouses in Norrkoping for e-commerce clients. Shift leads currently build performance reports by hand in spreadsheets every Monday, using exports from the StockPilot warehouse management system.

## Deliverables
${v === 1 ? 'Four dashboards' : 'Five dashboards'} built on StockPilot data:
- Inbound: dock-to-stock time per supplier.
- Picking: pick accuracy and picks per hour.
- Outbound: on-time dispatch rate per carrier.
- Labour: productivity per shift and team.
${v === 1 ? '' : '- Returns: returns processing time and reasons.\n'}
Data is refreshed ${v === 3 ? 'every 15 minutes' : 'every hour'}.${v === 3 ? ' A two-hour training session is included for the 12 shift leads.' : ''}

## Price and milestones
${v === 1 ? 'Fixed price EUR 14,000, invoiced in two milestones: 50% when the dashboard designs are signed off and 50% at go-live.' : 'Fixed price EUR 15,500, invoiced in three milestones: 30% when the dashboard designs are signed off, 40% when the first three dashboards are live and 30% at final go-live.'}

## Timeline
Design sign-off by 4 July 2025. Final go-live on ${v === 3 ? '1 September 2025' : '15 August 2025'}.

## Client responsibilities
Orchid provides read access to the StockPilot reporting database, a named contact in each warehouse and screens for the warehouse floor.

## Out of scope
Changes to StockPilot itself, carrier integrations, and any dashboards for individual e-commerce clients.
`
}
await docxFile(`${ORC}/Orchid_SOW_v1.docx`, '2025-06-02', 'Orchid SOW v1', orchidSow(1))
await docxFile(`${ORC}/Orchid_SOW_v2.docx`, '2025-06-11', 'Orchid SOW v2', orchidSow(2))
await docxFile(`${ORC}/Copy of Orchid_SOW_v2.docx`, '2025-06-19', 'Orchid SOW v2', orchidSow(3))
family('Orchid statement of work', [`${ORC}/Orchid_SOW_v1.docx`, `${ORC}/Orchid_SOW_v2.docx`, `${ORC}/Copy of Orchid_SOW_v2.docx`])

txt(
  `${ORC}/kpi-definitions.md`,
  '2025-07-08',
  `# Orchid KPI definitions (agreed 8 July 2025)

Dock-to-stock time: minutes from the truck being registered at the gate until every pallet is put away and scannable in StockPilot. Target: under 240 minutes.

Pick accuracy: share of order lines picked with the right item and quantity, measured by the pack station scan. Target: 99.5%.

Picks per hour: order lines picked per paid picking hour, excluding breaks.

On-time dispatch: share of orders handed to the carrier before the carrier's cut-off time. Target: 98%.

Returns processing time: hours from a return being scanned at the gate until it is restocked or written off. Target: 48 hours.
`
)

txt(
  `${ORC}/status-2025-08-05.md`,
  '2025-08-05',
  `# Weekly status - Orchid warehouse dashboards
Week 32, 5 August 2025. Status: amber

## Done this week
- Inbound and picking dashboards live on the warehouse floor screens in all three sites.
- Pick accuracy numbers checked against the pack station scans for one week.

## Next week
- Returns dashboard, first version.
- Agree the colours for the on-time dispatch thresholds with Hana Kobayashi.

## Risks
- The StockPilot replica lags up to 20 minutes at shift change, which breaks the 15 minute refresh.

## Budget
EUR 4,650 invoiced of EUR 15,500.

Status colours: green means on track, amber means at risk but recoverable, red means a decision from the client is needed. Reply to this note with questions; the next status note follows in one week.
`
)
distractor(`${ACME}/status-2026-04-07.md`, `${ORC}/status-2025-08-05.md`, 'same weekly status template, different project')

// ---------- Maya's own business documents ----------
function rateCard(year) {
  const r =
    year === 2025
      ? { day: '720', half: '400', workshop: '1,900', sprint: '6,500', rush: '25%', retainer: '2,600', np: '10%' }
      : { day: '780', half: '430', workshop: '2,100', sprint: '7,000', rush: '30%', retainer: '2,850', np: '15%' }
  return `# Rate card ${year}
Maya Lindqvist Consulting - service and product design
Valid from 1 January ${year}. All prices in euro, excluding VAT.

## Day rates
Full day (8 hours): EUR ${r.day}
Half day (4 hours): EUR ${r.half}

## Packages
Workshop for up to 12 participants, including preparation and a written summary: EUR ${r.workshop}
Discovery sprint (two weeks: interviews, journey map, prioritised recommendations): EUR ${r.sprint}
Retainer, four days per month with a three month minimum: EUR ${r.retainer} per month

## Surcharges and discounts
Rush work starting within five working days: +${r.rush}
Registered charities and non-profit organisations: ${r.np} discount

## Terms
Invoices are payable within 30 days. Workshops cancelled with less than 7 days notice are charged at 50%. Travel outside Sweden is billed at cost.
`
}
pdfFile('business/Maya_Rate_Card_2025.pdf', '2025-01-08', 'Rate card 2025', rateCard(2025))
pdfFile('business/Maya_Rate_Card_2026.pdf', '2026-01-05', 'Rate card 2026', rateCard(2026))
family('Maya rate card', ['business/Maya_Rate_Card_2025.pdf', 'business/Maya_Rate_Card_2026.pdf'])

txt(
  'business/terms-and-conditions.md',
  '2024-03-04',
  `# Standard terms and conditions
Maya Lindqvist Consulting, version March 2024

1. These terms apply to all assignments unless a signed agreement says otherwise.
2. Quotes are valid for 30 days.
3. Invoices are payable within 30 days. Late payment interest is charged according to the Swedish Interest Act, plus a reminder fee of SEK 60.
4. Cancelled workshops: more than 7 days notice is free of charge; less than 7 days notice is charged at 50%; less than 48 hours at 100%.
5. The client owns the final deliverables once they are paid for. Sketches, templates and methods remain mine.
6. I may mention the client's name in my portfolio unless the client objects in writing.
7. My liability is limited to the fee for the assignment.
8. Swedish law applies.
`
)

txt(
  'business/professional-indemnity-summary.txt',
  '2025-04-02',
  `Professional indemnity cover - policy summary
Insurer: Nordhavn Mutual
Policy holder: Maya Lindqvist Consulting
Policy number: NM-PI-2291-0457
Period: 1 April 2025 to 31 March 2026, renews automatically

Cover: claims from clients for financial loss caused by errors or negligence in consulting advice.
Limit: SEK 10,000,000 per claim and per year.
Excess: SEK 15,000 per claim.
Annual premium: SEK 4,320.
Not covered: contractual penalties, fines, work done outside the EU and EEA.
To report a matter, call the claims line within 30 days of becoming aware of it.
`
)

txt(
  'business/pricing-blog-draft.md',
  '2025-05-29',
  `# Draft: How I price small consulting projects

Most of my projects are between EUR 6,000 and EUR 30,000. For years I quoted day rates and lost money every time a "small change" turned into three extra workshops. These days I price almost everything as a fixed fee, with a clear scope and a short list of what is out of scope.

Three things that changed my pricing:

1. Anchor on the value, not the hours. If a dental clinic loses EUR 200,000 a year to missed appointments, a EUR 9,500 reminder service is an easy decision.
2. Split the payment so both sides carry risk. I used to ask for 50% up front. Now I usually ask for 40% and attach the rest to milestones the client can see, like "calendar live".
3. Write down what is out of scope. Gift cards, integrations with systems that have no API, and translations are the usual suspects.

Still unsure about: whether to publish my rates on the website.
`
)

txt(
  'business/client-list-2025.md',
  '2025-12-30',
  `# Clients 2025

| Client | Project | Fee (EUR) | Status |
|---|---|---|---|
| Fernhill Library Trust | Catalogue migration (finished March) | 27,880 | Paid |
| Larkspur Architects | Drawing archive search | 13,500 | Paid |
| Harbor & Pine Hotels | Pre-arrival guest journey | 16,500 | Paid |
| Orchid Logistics | Warehouse KPI dashboards | 15,500 | Paid |
| Kestrel Bakery Co-op | Online pre-orders | 7,200 | Second half due |
| Bluebird Dental Clinics | Patient reminders | 9,500 | Kickoff paid |

Total project value: EUR 90,080 across six clients. Best month: August.
`
)

await docxFile(
  'business/templates/Maya_Proposal_Template.docx',
  '2024-03-01',
  'Proposal template',
  mayaProposal({
    title: '[Project name] - Proposal',
    client: '[Client name]',
    date: '[date]',
    summary: '[Two or three sentences on the client, the problem and what this proposal covers.]',
    scope: '[What is included. Be concrete.]',
    fees: '[Total fee and how it is split.]',
    timeline: '[Start date, milestones, end date.]',
    warranty: 'Defects reported within [30] days of launch are fixed at no extra cost.'
  })
)

// ---------- CV ----------
function cv(year) {
  const recent =
    year >= 2026
      ? `Acme Outdoor Co. (2026): redesign of the booking system for guided trips, with live availability, waitlists and group bookings.
Bluebird Dental Clinics (2025-2026): patient reminder service by SMS and email; no-show rate fell from 18% to 11% in the first month.
`
      : ''
  const mid =
    year >= 2025
      ? `Orchid Logistics (2025): warehouse KPI dashboards for three sites, used daily by 12 shift leads.
Harbor & Pine Hotels (2025): pre-arrival guest journey for three boutique hotels.
Larkspur Architects (2025): searchable archive for 22 years of drawings.
`
      : ''
  return `# Maya Lindqvist
Service designer and product consultant - Uppsala, Sweden
maya@lindqvist-consulting.se | +46 70 214 88 31

## Profile
I help small organisations fix the flows their customers touch every day: booking, ordering, reminders and follow-up. Twelve years of design experience, the last ${year - 2021} as an independent consultant.

## Selected projects
${recent}${mid}Fernhill Library Trust (2024-2025): migration of 186,000 catalogue records and a new public search.
Uppsala Bike Kitchen (2023): volunteer scheduling and repair booking.

## Experience
Independent consultant, Maya Lindqvist Consulting, 2021 - present
Senior UX designer, Nordbank, Stockholm, 2016 - 2021. Led the redesign of the mobile loan application, which cut drop-off by a third.
Designer, Studio Kvist, Uppsala, 2013 - 2016

## Education
MSc Human-Computer Interaction, Uppsala University, 2013
${year >= 2025 ? '\n## Certifications\nCertified Scrum Product Owner (CSPO), 2024\n' : ''}${year >= 2026 ? '\n## Speaking\nNordic UX Summit 2025: "Small fixes, fewer no-shows"\n' : ''}
## Languages
Swedish (native), English (fluent), German (${year >= 2025 ? 'conversational' : 'basic'})
`
}
const CV = 'personal/career'
pdfFile(`${CV}/Maya_Lindqvist_CV_2024.pdf`, '2024-02-15', 'Maya Lindqvist CV', cv(2024))
await docxFile(`${CV}/Maya_Lindqvist_CV_2025.docx`, '2025-03-20', 'Maya Lindqvist CV', cv(2025))
await docxFile(`${CV}/Maya_Lindqvist_CV_2026-02-10.docx`, '2026-02-10', 'Maya Lindqvist CV', cv(2026))
copyOf('Downloads/Copy of Maya_Lindqvist_CV_2026-02-10.docx', '2026-02-11', `${CV}/Maya_Lindqvist_CV_2026-02-10.docx`)
family('Maya CV', [`${CV}/Maya_Lindqvist_CV_2024.pdf`, `${CV}/Maya_Lindqvist_CV_2025.docx`, `${CV}/Maya_Lindqvist_CV_2026-02-10.docx`])

txt(
  `${CV}/speaker-bio.txt`,
  '2025-09-12',
  `Speaker bio (short)
Maya Lindqvist is an independent service designer from Uppsala. She works with clinics, hotels, bakeries and logistics companies on the everyday flows customers actually touch. Before going freelance she led mobile design at Nordbank. At Nordic UX Summit 2025 she talks about how a reminder SMS cut missed dental appointments by a third.
`
)

// =====================================================================================================
// Persona 2: Tidewater Labs, a small software team (builds the booking platform used by Acme)
// =====================================================================================================
const TW = 'projects/tidewater'

const POLICY_HEAD = (title, version, date) => `# Tidewater Labs AB - ${title}
Document owner: Head of Operations | Version: ${version} | Approved: ${date}
Applies to: all employees, contractors and interns. Review cycle: yearly.
`
const POLICY_FOOT = `## Roles
The Head of Operations owns this policy and keeps it up to date. Managers make sure their team members have read it and understand it. Every employee and contractor is responsible for following it in their daily work.

## Policy review
This policy is reviewed once a year, or earlier after a serious incident or a change in the law. Changes are announced in the company channel and take effect 14 days after approval.

## Exceptions and breaches
Exceptions must be approved in writing by the Head of Operations and are reviewed at the next policy review. Breaches of this policy may lead to disciplinary action. Questions about this policy go to ops@tidewaterlabs.se.`

function securityPolicy(v) {
  const p = {
    1: { ver: '2024.1', date: '2 April 2024', pw: 'Passwords must be at least 12 characters and stored in the company password manager (Bitwarden).', mfa: 'Multi-factor authentication is required for all admin accounts.', lock: '10 minutes', inc: '72 hours', review: 'once a year', backup: 'Production databases are backed up daily and backups are kept for 30 days.', access: 'Production systems are only reachable through the company VPN.', training: '' },
    2: { ver: '2025.1', date: '10 April 2025', pw: 'Passwords must be at least 14 characters and stored in the company password manager (Bitwarden).', mfa: 'Multi-factor authentication is required for all staff accounts.', lock: '5 minutes', inc: '48 hours', review: 'twice a year', backup: 'Production databases are backed up daily and backups are kept for 35 days.', access: 'Production systems are only reachable through single sign-on and the company VPN.', training: 'All staff complete phishing awareness training once a year.' },
    3: { ver: '2026.1', date: '2 March 2026', pw: 'Passkeys are the preferred way to sign in. Where a system does not support passkeys, passwords must be at least 14 characters and stored in the company password manager (Bitwarden).', mfa: 'Multi-factor authentication is required for all accounts, including contractors.', lock: '5 minutes', inc: '24 hours', review: 'every quarter', backup: 'Production databases are backed up daily, backups are kept for 35 days and a restore is tested every month.', access: 'Production systems are only reachable through single sign-on and the zero-trust access proxy. The old VPN was retired in January 2026.', training: 'All staff complete phishing awareness training twice a year. USB storage devices may not be used on company laptops.' }
  }[v]
  return `${POLICY_HEAD('Information Security Policy', p.ver, p.date)}
## Purpose
This policy protects customer booking and payment data and the systems Tidewater Labs runs for its clients.

## Accounts and passwords
${p.pw} ${p.mfa} Shared accounts are not allowed.

## Laptops and devices
Company laptops use full-disk encryption (BitLocker or FileVault) and lock the screen after ${p.lock} of inactivity. Lost or stolen devices are reported immediately.${p.training ? ' ' + p.training : ''}

## Access control
Access is granted per role and removed on the last working day. Access rights are reviewed ${p.review}. ${p.access}

## Backups
${p.backup}

## Security incidents
Anyone who suspects a security incident, such as a leaked password, a phishing click or unexpected access to customer data, reports it to security@tidewaterlabs.se within ${p.inc}. Personal data breaches are assessed for notification to the data protection authority.

${POLICY_FOOT}
`
}
pdfFile(`${TW}/policies/Tidewater_Information_Security_Policy_2024.pdf`, '2024-04-02', 'Information Security Policy 2024', securityPolicy(1))
await docxFile(`${TW}/policies/Tidewater_Information_Security_Policy_2025.docx`, '2025-04-10', 'Information Security Policy 2025', securityPolicy(2))
await docxFile(`${TW}/policies/Tidewater_Information_Security_Policy_2026-03-02.docx`, '2026-03-02', 'Information Security Policy 2026', securityPolicy(3))
family('Tidewater information security policy', [
  `${TW}/policies/Tidewater_Information_Security_Policy_2024.pdf`,
  `${TW}/policies/Tidewater_Information_Security_Policy_2025.docx`,
  `${TW}/policies/Tidewater_Information_Security_Policy_2026-03-02.docx`
])

await docxFile(
  `${TW}/policies/Tidewater_Remote_Work_Policy.docx`,
  '2025-01-15',
  'Remote Work Policy',
  `${POLICY_HEAD('Remote Work Policy', '2025.1', '15 January 2025')}
## Purpose
This policy explains when and how staff can work away from the Malmo office.

## Eligibility
Everyone can work remotely after the six month probation period. During probation, at least three days a week are spent in the office.

## Core hours
Core hours are 10:00 to 15:00 CET. Outside core hours you plan your own time, but you keep your calendar up to date.

## Home office
Tidewater pays a one-off home office allowance of SEK 5,000 for a chair, a screen or a desk. Company laptops and headsets are provided.

## Working abroad
You can work from another country for up to 20 working days per year, after telling your manager. Longer stays need approval because of tax and insurance rules.

## Security
Never work on customer data on public Wi-Fi without the company access proxy. Lock your screen in shared spaces.

${POLICY_FOOT}
`
)
distractor(`${TW}/policies/Tidewater_Information_Security_Policy_2025.docx`, `${TW}/policies/Tidewater_Remote_Work_Policy.docx`, 'same policy header and footer template, different policy')

function retro(n, date, well, improve, actions) {
  return `# Sprint ${n} retrospective
Team: Tidewater booking platform | Date: ${date} | Facilitator: rotates

## What went well
${well.map((w) => `- ${w}`).join('\n')}

## What did not go well
${improve.map((w) => `- ${w}`).join('\n')}

## Actions
${actions.map((w) => `- ${w}`).join('\n')}

## Mood
Average team mood this sprint (1-5): ${n === 12 ? '3.4' : n === 13 ? '3.9' : '4.1'}

## Format reminder
Ten minutes of silent writing, then everyone reads their notes aloud. We group similar notes, vote with three dots each and pick at most two actions, each with one owner. Actions from the last retro are checked first. What is said in the retro stays in the team.
`
}
txt(
  `${TW}/retros/sprint-12-retro.md`,
  '2026-02-27',
  retro(12, '27 February 2026',
    ['Refresh token rotation shipped without downtime.', 'Pairing on the pricing rules helped Noor get up to speed.'],
    ['Flaky end-to-end tests blocked two deploys; the checkout test depends on the payment sandbox.', 'Too many meetings on Wednesday: planning, refinement and the client demo on the same day.'],
    ['Mock the payment sandbox in end-to-end tests (Viktor).', 'Move refinement to Tuesday afternoon (Karin).'])
)
txt(
  `${TW}/retros/sprint-13-retro.md`,
  '2026-03-13',
  retro(13, '13 March 2026',
    ['Seat hold with SELECT FOR UPDATE stopped double bookings in the load test with 40 parallel checkouts.', 'Mocked payment sandbox: no flaky deploys this sprint.'],
    ['The waitlist emails went out in English to Swedish customers because the locale was not passed through.', 'Code review waiting times of up to two days.'],
    ['Add locale to every notification job and a test for it (Noor).', 'Review requests answered within four working hours (everyone).'])
)
txt(
  `${TW}/retros/sprint-14-retro.md`,
  '2026-03-27',
  retro(14, '27 March 2026',
    ['Availability calendar demo to Acme went well; Jonas signed off the design.', 'Database migration 006 added the index on reservations and the availability query went from 900 ms to 40 ms.'],
    ['On-call was noisy: 31 alerts in one night from the webhook retry queue, none of them real problems.', 'Nobody owned the staging database clean-up.'],
    ['Raise the webhook retry alert threshold and group alerts per hour (Viktor).', 'Weekly staging reset by script on Sunday night (Karin).'])
)
distractor(`${TW}/retros/sprint-12-retro.md`, `${TW}/retros/sprint-13-retro.md`, 'same retro template, different sprint')

txt(
  `${TW}/meetings/2026-03-04 architecture sync.md`,
  '2026-03-04',
  `# Architecture sync - 4 March 2026
Present: Karin Ostlund (tech lead), Viktor Hall, Noor Aziz, Maya Lindqvist (for Acme)

## Seat holds
Maya explained the Acme problem: two customers can pay for the last seat at the same time. Decision: a reservation row with status "held" is inserted inside a transaction that locks the trip row (SELECT ... FOR UPDATE). Holds expire after 10 minutes and a job releases them every minute.

## Group bookings
Groups up to 12 people are one reservation with a seat count, not 12 reservations. Pricing gives 10% off from 6 people and 15% from 10.

## Webhooks
We will store every processed payment event id so a retried webhook is ignored (idempotency). See ADR 0002.

## Decisions
- Postgres stays the only database; no Redis for locks.
- Karin writes migration 005 for the waitlist table.
`
)
txt(
  `${TW}/meetings/2026-03-18 payments review.md`,
  '2026-03-18',
  `# Payments review - 18 March 2026
Present: Karin Ostlund, Viktor Hall, Priya Nair (Acme finance, guest)

- Priya asked why some refunds take a week. Answer: refunds are only triggered when staff cancel a trip in the admin view, and the admin view batches them nightly. We will trigger refunds immediately instead.
- Cancellation policy in code must match the terms on the website: full refund more than 7 days before departure, 50% between 7 days and 48 hours, nothing within 48 hours.
- Partial refunds for groups: if 3 of 8 people cancel, refund 3 seats at the price they paid, including the group discount.
- Payment provider fees are not refunded; Acme accepts that.
- Viktor will add a refund reason field for the finance export.
`
)
txt(
  `${TW}/meetings/2026-05-06 planning.md`,
  '2026-05-06',
  `# Planning - 6 May 2026
Present: whole team

Goals for the next two sprints:
1. Group booking flow for Acme (one order, up to 12 people, one lead contact).
2. Pickup point selection at checkout.
3. Move SMS reminders to the new provider; the old one raises prices on 1 July.

Capacity: Noor is on parental leave from 20 May. Karin is at a conference on 14-15 May.
Risk: the pickup point list from Acme is still missing GPS coordinates.
`
)
txt(
  `${TW}/meetings/2025-11-19 incident review.md`,
  '2025-11-19',
  `# Incident review - payment webhooks down (18 November 2025)
Present: Karin Ostlund, Viktor Hall, Noor Aziz

## What happened
From 14:05 to 17:45 on 18 November 2025 (3 hours 40 minutes), every payment webhook was rejected with HTTP 401. The payment provider had rotated our webhook signing secret after we clicked "roll secret" during a dashboard clean-up, and the new secret was never put in the production config.

## Impact
212 bookings stayed in "pending payment" although customers had paid. 37 customers emailed support. No money was lost.

## Fix
The new secret was deployed at 17:40 and the provider resent all failed events; the idempotency table made sure none was processed twice.

## Follow-up
- Alert when more than 5 webhooks in 10 minutes fail signature checks.
- Store the signing secret in the secrets manager, not in config files.
- Write a runbook for rotating the secret with a 24 hour overlap.
`
)
txt(
  `${TW}/roadmap-2026.md`,
  '2026-01-14',
  `# Tidewater booking platform - roadmap 2026

## Q1
- Refresh token rotation and reuse detection
- Seat holds to stop double bookings (Acme)
- Availability calendar API

## Q2
- Group bookings up to 12 people
- Pickup points
- New SMS provider

## Q3
- Gift cards (asked for by Acme, not yet sold)
- Multi-currency checkout (EUR, SEK, NOK)

## Q4
- Self-service reporting for trip operators
- Accessibility audit of the checkout (WCAG 2.2 AA)
`
)
// ---------- code/tidewater-booking: the booking and payments service ----------
const REPO = 'code/tidewater-booking'

txt(
  `${REPO}/README.md`,
  '2026-03-20',
  `# tidewater-booking

Booking and payments service for guided trip operators (first customer: Acme Outdoor). Node 20, TypeScript, Express and Postgres.

## Running locally
1. Copy config/staging.yaml to config/local.yaml and point it at your database.
2. docker compose up -d db
3. npm install
4. npm run migrate
5. npm run dev  (listens on port 4010)

## Modules
- src/auth: access and refresh tokens, password hashing, the requireAuth middleware
- src/booking: availability, seat holds, reservations, pricing, waitlist, cancellations
- src/payments: checkout sessions, payment webhooks, refunds
- src/notifications: confirmation emails and SMS reminders
- src/jobs: scheduled jobs (release expired holds, send reminders)

## Deploying
scripts/deploy.sh staging|production. Production deploys need an approved pull request and a green test run.

## Testing
npm test runs unit and integration tests against a throwaway database.
`
)

txt(
  `${REPO}/package.json`,
  '2026-03-20',
  `{
  "name": "tidewater-booking",
  "version": "1.8.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "migrate": "node scripts/migrate.mjs",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.21.0",
    "pg": "^8.13.0",
    "jose": "^5.9.0",
    "nodemailer": "^6.9.0",
    "node-cron": "^3.0.3",
    "yaml": "^2.6.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "tsx": "^4.19.0",
    "vitest": "^2.1.0"
  }
}
`
)

txt(
  `${REPO}/tsconfig.json`,
  '2025-09-02',
  `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "lib",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`
)

txt(
  `${REPO}/docker-compose.yml`,
  '2025-09-02',
  `services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: tidewater
      POSTGRES_PASSWORD: localdev
      POSTGRES_DB: booking
    ports:
      - "5433:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
  mailcatcher:
    image: sj26/mailcatcher
    ports:
      - "1080:1080"
volumes:
  pgdata:
`
)

txt(
  `${REPO}/CHANGELOG.md`,
  '2026-05-02',
  `# Changelog

## 1.8.0 - 2026-05-02
- Waitlist: the next person is offered a freed seat automatically and has 2 hours to accept.
- Cancellations follow the published policy (full refund more than 7 days before departure).

## 1.7.0 - 2026-03-26
- Index on reservations (trip_id, status) makes the availability query about 20 times faster.
- Seat holds of 10 minutes stop two customers from booking the last seat.

## 1.6.0 - 2026-02-24
- Refresh tokens rotate on every use; reusing an old refresh token revokes the whole session family.

## 1.5.2 - 2025-11-20
- Payment webhooks: alert on repeated signature failures after the November outage.

## 1.5.0 - 2025-10-08
- Checkout sessions with the payment provider; amounts stored in cents.
`
)

txt(
  `${REPO}/src/server.ts`,
  '2026-03-05',
  `import express from 'express'
import { config } from './config.js'
import { requireAuth, requireRole } from './auth/middleware.js'
import { login, refresh } from './auth/routes.js'
import { getAvailability } from './booking/availability.js'
import { holdSeats, confirmReservation } from './booking/reservations.js'
import { joinWaitlist } from './booking/waitlist.js'
import { createCheckoutSession } from './payments/checkout.js'
import { handlePaymentWebhook } from './payments/webhooks.js'
import { rateLimit } from './lib/rateLimit.js'
import { startJobs } from './jobs/scheduler.js'

const app = express()

// The webhook needs the raw body to verify the signature, so it is mounted before express.json().
app.post('/webhooks/payments', express.raw({ type: 'application/json' }), handlePaymentWebhook)
app.use(express.json())

app.post('/auth/login', rateLimit({ perMinute: 5 }), login)
app.post('/auth/refresh', rateLimit({ perMinute: 30 }), refresh)

app.get('/trips/:tripId/availability', rateLimit({ perMinute: 60 }), async (req, res) => {
  res.json(await getAvailability(req.params.tripId, String(req.query.date)))
})
app.post('/trips/:tripId/holds', requireAuth, async (req, res) => {
  res.status(201).json(await holdSeats(req.params.tripId, req.user.id, Number(req.body.seats)))
})
app.post('/reservations/:id/checkout', requireAuth, async (req, res) => {
  res.json(await createCheckoutSession(req.params.id))
})
app.post('/reservations/:id/confirm', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await confirmReservation(req.params.id))
})
app.post('/trips/:tripId/waitlist', requireAuth, async (req, res) => {
  res.status(201).json(await joinWaitlist(req.params.tripId, req.user.id, Number(req.body.seats)))
})

app.listen(config.port, () => {
  startJobs()
  console.log('tidewater-booking listening on ' + config.port)
})
`
)

txt(
  `${REPO}/src/config.ts`,
  '2025-11-19',
  `import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

interface Config {
  port: number
  databaseUrl: string
  jwtSecret: string
  payment: { apiKey: string; webhookSecret: string; webhookToleranceSeconds: number }
  smtp: { host: string; port: number; from: string }
  sms: { provider: string; sender: string }
}

const env = process.env.APP_ENV ?? 'local'
const file = parse(readFileSync('config/' + env + '.yaml', 'utf8'))

// Secrets come from the environment (injected by the secrets manager), never from the YAML files.
export const config: Config = {
  port: file.port ?? 4010,
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  payment: {
    apiKey: required('PAYMENT_API_KEY'),
    webhookSecret: required('PAYMENT_WEBHOOK_SECRET'),
    webhookToleranceSeconds: file.payment?.webhookToleranceSeconds ?? 300
  },
  smtp: file.smtp,
  sms: file.sms
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error('Missing environment variable ' + name)
  return value
}
`
)

txt(
  `${REPO}/src/db/client.ts`,
  '2025-09-03',
  `import pg from 'pg'
import { config } from '../config.js'

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, idleTimeoutMillis: 30000 })

/** Runs fn inside a transaction; rolls back on any error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
`
)

txt(
  `${REPO}/src/auth/tokens.ts`,
  '2026-02-24',
  `import { randomBytes, createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { pool } from '../db/client.js'
import { config } from '../config.js'

const ACCESS_TTL_SECONDS = 15 * 60
const REFRESH_TTL_DAYS = 30
const key = new TextEncoder().encode(config.jwtSecret)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Issues a short-lived access token and a long-lived refresh token after login. */
export async function issueTokens(userId: string, familyId = randomBytes(16).toString('hex')) {
  const accessToken = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS)
    .sign(key)
  const refreshToken = randomBytes(32).toString('base64url')
  await pool.query(
    "INSERT INTO refresh_tokens (token_hash, user_id, family_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
    [sha256(refreshToken), userId, familyId]
  )
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

/**
 * Exchanges a refresh token for a new pair. Refresh tokens rotate: each one can be used once.
 * If an already-used token is presented again, someone may have stolen it, so the whole family
 * (every token issued from the same login) is revoked and the user has to sign in again.
 */
export async function refreshAccessToken(refreshToken: string) {
  const { rows } = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)])
  const row = rows[0]
  if (!row || row.expires_at < new Date()) throw new AuthError('Refresh token expired or unknown')
  if (row.used_at) {
    await pool.query('UPDATE refresh_tokens SET revoked = true WHERE family_id = $1', [row.family_id])
    throw new AuthError('Refresh token reuse detected; session revoked')
  }
  if (row.revoked) throw new AuthError('Session revoked')
  await pool.query('UPDATE refresh_tokens SET used_at = now() WHERE token_hash = $1', [row.token_hash])
  return issueTokens(row.user_id, row.family_id)
}

export async function verifyAccessToken(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, key)
  return String(payload.sub)
}

export async function revokeAllSessions(userId: string) {
  await pool.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [userId])
}

export class AuthError extends Error {}
`
)

txt(
  `${REPO}/src/auth/middleware.ts`,
  '2025-10-01',
  `import type { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from './tokens.js'
import { pool } from '../db/client.js'

/** Rejects requests without a valid Bearer access token and attaches the user to the request. */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return res.status(401).json({ error: 'Not signed in' })
  try {
    const userId = await verifyAccessToken(token)
    const { rows } = await pool.query('SELECT id, role FROM users WHERE id = $1 AND disabled = false', [userId])
    if (!rows[0]) return res.status(401).json({ error: 'Account disabled' })
    req.user = rows[0]
    next()
  } catch {
    // Expired access tokens land here; the client should call /auth/refresh and retry.
    res.status(401).json({ error: 'Token expired' })
  }
}

export function requireRole(role: 'admin' | 'guide') {
  return (req: Request, res: Response, next: NextFunction) =>
    req.user?.role === role ? next() : res.status(403).json({ error: 'Forbidden' })
}
`
)

txt(
  `${REPO}/src/auth/password.ts`,
  '2025-09-15',
  `import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { pool } from '../db/client.js'

const scryptAsync = promisify(scrypt)
const RESET_TOKEN_MINUTES = 60

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = (await scryptAsync(password, salt, 64)) as Buffer
  return salt.toString('hex') + ':' + hash.toString('hex')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  const hash = (await scryptAsync(password, Buffer.from(saltHex, 'hex'), 64)) as Buffer
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}

/** Creates a one-time password reset link token that expires after an hour. Only the hash is stored. */
export async function createResetToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url')
  const hash = createHash('sha256').update(token).digest('hex')
  await pool.query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))",
    [userId, hash, RESET_TOKEN_MINUTES]
  )
  return token
}
`
)

txt(
  `${REPO}/src/booking/availability.ts`,
  '2026-03-25',
  `import { pool } from '../db/client.js'
import { HOLD_MINUTES } from './reservations.js'

export interface Availability {
  tripId: string
  date: string
  capacity: number
  booked: number
  held: number
  spotsLeft: number
  waitlistOpen: boolean
}

/**
 * Open spots for a trip departure: capacity minus confirmed seats minus seats held by checkouts
 * that started less than HOLD_MINUTES ago. Uses the (trip_id, status) index from migration 006.
 */
export async function getAvailability(tripId: string, date: string): Promise<Availability> {
  const { rows } = await pool.query(
    "SELECT d.capacity, " +
      "COALESCE(SUM(r.seats) FILTER (WHERE r.status = 'confirmed'), 0) AS booked, " +
      "COALESCE(SUM(r.seats) FILTER (WHERE r.status = 'held' AND r.created_at > now() - make_interval(mins => $3)), 0) AS held " +
      'FROM departures d LEFT JOIN reservations r ON r.departure_id = d.id ' +
      'WHERE d.trip_id = $1 AND d.date = $2 GROUP BY d.capacity',
    [tripId, date, HOLD_MINUTES]
  )
  const { capacity = 0, booked = 0, held = 0 } = rows[0] ?? {}
  const spotsLeft = Math.max(0, capacity - booked - held)
  return { tripId, date, capacity, booked: Number(booked), held: Number(held), spotsLeft, waitlistOpen: spotsLeft === 0 }
}
`
)

txt(
  `${REPO}/src/booking/reservations.ts`,
  '2026-03-11',
  `import { pool, withTransaction } from '../db/client.js'
import { quotePrice } from './pricing.js'
import { notifyNextOnWaitlist } from './waitlist.js'

export const HOLD_MINUTES = 10
export const MAX_GROUP_SIZE = 12

/**
 * Holds seats while the customer pays. The departure row is locked with SELECT ... FOR UPDATE,
 * so two customers trying to book the last seat at the same moment are served one after the other
 * and the second one sees that the trip is full.
 */
export async function holdSeats(departureId: string, customerId: string, seats: number) {
  if (seats < 1 || seats > MAX_GROUP_SIZE) throw new BookingError('A booking is for 1 to ' + MAX_GROUP_SIZE + ' people')
  return withTransaction(async (db) => {
    const { rows } = await db.query('SELECT id, capacity FROM departures WHERE id = $1 FOR UPDATE', [departureId])
    if (!rows[0]) throw new BookingError('Unknown departure')
    const taken = await db.query(
      "SELECT COALESCE(SUM(seats), 0) AS n FROM reservations WHERE departure_id = $1 AND (status = 'confirmed' OR (status = 'held' AND created_at > now() - make_interval(mins => $2)))",
      [departureId, HOLD_MINUTES]
    )
    if (rows[0].capacity - Number(taken.rows[0].n) < seats) throw new BookingError('Not enough spots left')
    const price = await quotePrice(departureId, seats)
    const res = await db.query(
      "INSERT INTO reservations (departure_id, customer_id, seats, status, price_cents) VALUES ($1, $2, $3, 'held', $4) RETURNING id",
      [departureId, customerId, seats, price.totalCents]
    )
    return { reservationId: res.rows[0].id, expiresInMinutes: HOLD_MINUTES, price }
  })
}

/** Called by the payment webhook when the payment succeeded. */
export async function confirmReservation(reservationId: string) {
  await pool.query("UPDATE reservations SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [reservationId])
}

/** Runs every minute: holds older than HOLD_MINUTES are released so the seats show up as free again. */
export async function releaseExpiredHolds() {
  const { rows } = await pool.query(
    "UPDATE reservations SET status = 'expired' WHERE status = 'held' AND created_at < now() - make_interval(mins => $1) RETURNING departure_id",
    [HOLD_MINUTES]
  )
  for (const r of rows) await notifyNextOnWaitlist(r.departure_id)
  return rows.length
}

export class BookingError extends Error {}
`
)

txt(
  `${REPO}/src/booking/pricing.ts`,
  '2026-03-06',
  `import { pool } from '../db/client.js'

export interface Quote {
  seats: number
  unitCents: number
  discountPercent: number
  totalCents: number
}

/**
 * Price for a group: 10% off for 6 to 9 people, 15% off for 10 to 12 people.
 * Weekend departures (Saturday and Sunday) cost 20% more. Children under 12 pay half price,
 * which is handled when the lead contact lists the participants.
 */
export async function quotePrice(departureId: string, seats: number): Promise<Quote> {
  const { rows } = await pool.query(
    'SELECT t.base_price_cents, d.date FROM departures d JOIN trips t ON t.id = d.trip_id WHERE d.id = $1',
    [departureId]
  )
  const { base_price_cents, date } = rows[0]
  const day = new Date(date).getDay()
  const weekend = day === 0 || day === 6
  const unitCents = Math.round(base_price_cents * (weekend ? 1.2 : 1))
  const discountPercent = seats >= 10 ? 15 : seats >= 6 ? 10 : 0
  const totalCents = Math.round(unitCents * seats * (1 - discountPercent / 100))
  return { seats, unitCents, discountPercent, totalCents }
}
`
)

txt(
  `${REPO}/src/booking/waitlist.ts`,
  '2026-03-12',
  `import { pool } from '../db/client.js'
import { sendWaitlistOffer } from '../notifications/email.js'

const OFFER_HOURS = 2

export async function joinWaitlist(departureId: string, customerId: string, seats: number) {
  const { rows } = await pool.query(
    'INSERT INTO waitlist (departure_id, customer_id, seats) VALUES ($1, $2, $3) RETURNING id, position',
    [departureId, customerId, seats]
  )
  return rows[0]
}

/**
 * When seats are freed (a cancellation or an expired hold), the first person on the waitlist whose
 * group fits gets an email offer. They have OFFER_HOURS to accept before it moves to the next person.
 */
export async function notifyNextOnWaitlist(departureId: string) {
  const { rows } = await pool.query(
    "SELECT w.id, w.customer_id, w.seats, c.email, c.locale FROM waitlist w JOIN customers c ON c.id = w.customer_id " +
      "WHERE w.departure_id = $1 AND w.status = 'waiting' ORDER BY w.position LIMIT 1",
    [departureId]
  )
  if (!rows[0]) return
  await pool.query("UPDATE waitlist SET status = 'offered', offer_expires_at = now() + make_interval(hours => $2) WHERE id = $1", [rows[0].id, OFFER_HOURS])
  await sendWaitlistOffer(rows[0].email, rows[0].locale, departureId, OFFER_HOURS)
}
`
)

txt(
  `${REPO}/src/booking/cancellations.ts`,
  '2026-03-20',
  `import { pool } from '../db/client.js'
import { issueRefund } from '../payments/refunds.js'
import { notifyNextOnWaitlist } from './waitlist.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Refund share for a customer cancellation, matching the terms on the website:
 * more than 7 days before departure: 100%; between 7 days and 48 hours: 50%; within 48 hours: nothing.
 * Trips cancelled by the operator (weather, too few people) are always refunded in full.
 */
export function refundShare(departure: Date, now = new Date(), byOperator = false): number {
  if (byOperator) return 1
  const ms = departure.getTime() - now.getTime()
  if (ms > 7 * DAY_MS) return 1
  if (ms > 2 * DAY_MS) return 0.5
  return 0
}

export async function cancelReservation(reservationId: string, reason: string, byOperator = false) {
  const { rows } = await pool.query(
    'SELECT r.id, r.price_cents, r.payment_id, d.date, d.id AS departure_id FROM reservations r JOIN departures d ON d.id = r.departure_id WHERE r.id = $1',
    [reservationId]
  )
  const r = rows[0]
  const share = refundShare(new Date(r.date), new Date(), byOperator)
  await pool.query("UPDATE reservations SET status = 'cancelled', cancel_reason = $2 WHERE id = $1", [reservationId, reason])
  if (share > 0) await issueRefund(r.payment_id, Math.round(r.price_cents * share), reason)
  await notifyNextOnWaitlist(r.departure_id)
  return { refundedCents: Math.round(r.price_cents * share) }
}
`
)

txt(
  `${REPO}/src/payments/webhooks.ts`,
  '2025-11-20',
  `import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { config } from '../config.js'
import { pool } from '../db/client.js'
import { confirmReservation } from '../booking/reservations.js'
import { sendBookingConfirmation } from '../notifications/email.js'
import { log } from '../lib/logger.js'

/**
 * Receives events from the payment provider. Every request is signed: the header "Payment-Signature"
 * has the form "t=<unix time>,v1=<hex hmac>", where the HMAC-SHA256 covers "<t>.<raw body>".
 * We reject old timestamps to stop replay attacks, and store processed event ids so that the
 * provider's retries never confirm or refund a booking twice (see docs/adr/0002-idempotent-webhooks.md).
 */
export async function handlePaymentWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer
  if (!verifySignature(raw, String(req.headers['payment-signature'] ?? ''))) {
    log.warn('payment webhook signature check failed')
    return res.status(401).send('bad signature')
  }
  const event = JSON.parse(raw.toString('utf8'))
  const inserted = await pool.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [event.id])
  if (inserted.rowCount === 0) return res.status(200).send('already processed')

  switch (event.type) {
    case 'payment.succeeded':
      await confirmReservation(event.data.reservation_id)
      await sendBookingConfirmation(event.data.reservation_id)
      break
    case 'payment.failed':
      await pool.query("UPDATE reservations SET status = 'payment_failed' WHERE id = $1", [event.data.reservation_id])
      break
    case 'refund.completed':
      await pool.query("UPDATE refunds SET status = 'completed' WHERE provider_refund_id = $1", [event.data.refund_id])
      break
    default:
      log.info('ignored payment event ' + event.type)
  }
  res.status(200).send('ok')
}

export function verifySignature(raw: Buffer, header: string, now = Date.now()): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]))
  const t = Number(parts.t)
  if (!t || Math.abs(now / 1000 - t) > config.payment.webhookToleranceSeconds) return false
  const expected = createHmac('sha256', config.payment.webhookSecret).update(t + '.' + raw.toString('utf8')).digest()
  const given = Buffer.from(parts.v1 ?? '', 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}
`
)

txt(
  `${REPO}/src/payments/refunds.ts`,
  '2026-03-19',
  `import { pool } from '../db/client.js'
import { paymentApi } from './provider.js'
import { withRetry } from '../lib/retry.js'

/**
 * Refunds part or all of a payment. Refunds are sent to the provider immediately (they used to be
 * batched nightly, which made customers wait up to a week). Provider fees are not returned.
 */
export async function issueRefund(paymentId: string, amountCents: number, reason: string) {
  if (amountCents <= 0) return null
  const { rows } = await pool.query(
    "INSERT INTO refunds (payment_id, amount_cents, reason, status) VALUES ($1, $2, $3, 'requested') RETURNING id",
    [paymentId, amountCents, reason]
  )
  const refundId = rows[0].id
  const result = await withRetry(() => paymentApi.refunds.create({ payment: paymentId, amount: amountCents, idempotencyKey: 'refund-' + refundId }), { attempts: 4 })
  await pool.query('UPDATE refunds SET provider_refund_id = $2 WHERE id = $1', [refundId, result.id])
  return refundId
}
`
)

txt(
  `${REPO}/src/payments/checkout.ts`,
  '2025-10-08',
  `import { pool } from '../db/client.js'
import { paymentApi } from './provider.js'

/** Creates a hosted checkout page for a held reservation. Amounts are always integer cents in EUR. */
export async function createCheckoutSession(reservationId: string) {
  const { rows } = await pool.query(
    "SELECT id, price_cents, customer_id FROM reservations WHERE id = $1 AND status = 'held'",
    [reservationId]
  )
  if (!rows[0]) throw new Error('Reservation is not held any more; the 10 minute hold may have expired')
  const session = await paymentApi.checkout.create({
    amount: rows[0].price_cents,
    currency: 'EUR',
    metadata: { reservation_id: reservationId },
    successUrl: 'https://book.tidewaterlabs.se/done',
    cancelUrl: 'https://book.tidewaterlabs.se/cancelled'
  })
  await pool.query('UPDATE reservations SET payment_id = $2 WHERE id = $1', [reservationId, session.paymentId])
  return { url: session.url }
}
`
)

txt(
  `${REPO}/src/notifications/email.ts`,
  '2026-03-13',
  `import nodemailer from 'nodemailer'
import { config } from '../config.js'
import { withRetry } from '../lib/retry.js'
import { pool } from '../db/client.js'

const transport = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port })

const SUBJECTS = {
  confirmation: { sv: 'Din bokning ar bekraftad', en: 'Your booking is confirmed' },
  waitlist: { sv: 'En plats har blivit ledig', en: 'A spot has opened up' }
}

/** Sends the booking confirmation in the customer's language, retrying if the mail server is busy. */
export async function sendBookingConfirmation(reservationId: string) {
  const { rows } = await pool.query(
    'SELECT c.email, c.locale, t.name, d.date, r.seats FROM reservations r JOIN customers c ON c.id = r.customer_id JOIN departures d ON d.id = r.departure_id JOIN trips t ON t.id = d.trip_id WHERE r.id = $1',
    [reservationId]
  )
  const r = rows[0]
  const lang = r.locale === 'sv' ? 'sv' : 'en'
  await withRetry(() =>
    transport.sendMail({ from: config.smtp.from, to: r.email, subject: SUBJECTS.confirmation[lang], text: r.name + ', ' + r.date + ', ' + r.seats + ' people' })
  )
}

export async function sendWaitlistOffer(email: string, locale: string, departureId: string, hours: number) {
  const lang = locale === 'sv' ? 'sv' : 'en'
  await withRetry(() =>
    transport.sendMail({ from: config.smtp.from, to: email, subject: SUBJECTS.waitlist[lang], text: 'Accept within ' + hours + ' hours: https://book.tidewaterlabs.se/waitlist/' + departureId })
  )
}
`
)

txt(
  `${REPO}/src/notifications/sms.ts`,
  '2026-05-12',
  `import { config } from '../config.js'
import { withRetry } from '../lib/retry.js'

const REMINDER_HOURS_BEFORE = 48

/** Trip reminder by SMS two days before departure, with the pickup point and the guide's phone number. */
export async function sendTripReminderSms(phone: string, tripName: string, pickup: string, guidePhone: string) {
  const text = 'Reminder: ' + tripName + ' leaves in ' + REMINDER_HOURS_BEFORE + ' hours from ' + pickup + '. Guide: ' + guidePhone
  await withRetry(() => sendSms(phone, text), { attempts: 3 })
}

async function sendSms(to: string, text: string) {
  const res = await fetch('https://api.' + config.sms.provider + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: config.sms.sender, to, text })
  })
  if (!res.ok) throw new Error('SMS provider returned ' + res.status)
}
`
)

txt(
  `${REPO}/src/lib/retry.ts`,
  '2025-10-02',
  `export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
}

/**
 * Calls fn until it succeeds, waiting longer after each failure (exponential backoff with full jitter):
 * the wait is a random time between 0 and min(maxDelay, baseDelay * 2^attempt).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { attempts = 5, baseDelayMs = 200, maxDelayMs = 10000 } = opts
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (i === attempts - 1) break
      const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** i)
      await new Promise((r) => setTimeout(r, Math.random() * cap))
    }
  }
  throw lastError
}
`
)

txt(
  `${REPO}/src/lib/rateLimit.ts`,
  '2025-10-03',
  `import type { Request, Response, NextFunction } from 'express'

interface Bucket {
  tokens: number
  updated: number
}

/**
 * Token bucket per client IP. Each bucket holds perMinute tokens and refills continuously.
 * The login route uses 5 per minute to slow down password guessing.
 */
export function rateLimit({ perMinute }: { perMinute: number }) {
  const buckets = new Map<string, Bucket>()
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now()
    const ip = req.ip ?? 'unknown'
    const b = buckets.get(ip) ?? { tokens: perMinute, updated: now }
    b.tokens = Math.min(perMinute, b.tokens + ((now - b.updated) / 60000) * perMinute)
    b.updated = now
    if (b.tokens < 1) {
      res.setHeader('Retry-After', '60')
      return res.status(429).json({ error: 'Too many requests' })
    }
    b.tokens -= 1
    buckets.set(ip, b)
    next()
  }
}
`
)

txt(
  `${REPO}/src/lib/logger.ts`,
  '2025-09-10',
  `const CARD = /\\b(?:\\d[ -]?){13,19}\\b/g
const EMAIL = /[\\w.+-]+@[\\w-]+\\.[\\w.]+/g

/** Removes card numbers and email addresses before anything is written to the logs. */
export function redact(message: string): string {
  return message.replace(CARD, '[card]').replace(EMAIL, '[email]')
}

function write(level: string, message: string) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message: redact(message) }))
}

export const log = {
  info: (m: string) => write('info', m),
  warn: (m: string) => write('warn', m),
  error: (m: string) => write('error', m)
}
`
)

txt(
  `${REPO}/src/lib/money.ts`,
  '2025-10-08',
  `/** Converts a euro amount typed by staff ("249,50" or "249.50") to integer cents without float drift. */
export function toCents(input: string): number {
  const normalised = input.trim().replace(/\\s/g, '').replace(',', '.')
  const [whole, frac = ''] = normalised.split('.')
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2))
}

export function formatEUR(cents: number, locale = 'sv-SE'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(cents / 100)
}
`
)

txt(
  `${REPO}/src/jobs/scheduler.ts`,
  '2026-03-11',
  `import cron from 'node-cron'
import { releaseExpiredHolds } from '../booking/reservations.js'
import { sendDueReminders } from '../notifications/reminders.js'
import { log } from '../lib/logger.js'

/** Background jobs. Times are Europe/Stockholm. */
export function startJobs() {
  // Every minute: free seats from checkouts that were abandoned.
  cron.schedule('* * * * *', async () => {
    const n = await releaseExpiredHolds()
    if (n) log.info('released ' + n + ' expired holds')
  })
  // Every hour at :05: SMS reminders for trips that leave in 48 hours.
  cron.schedule('5 * * * *', sendDueReminders, { timezone: 'Europe/Stockholm' })
}
`
)

const MIG = `${REPO}/migrations`
txt(`${MIG}/001_create_users.sql`, '2025-09-03', `-- Users of the admin view (staff and guides) and customers who book trips.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'guide')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  phone text,
  locale text NOT NULL DEFAULT 'sv'
);

CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  family_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked boolean NOT NULL DEFAULT false
);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
`)
txt(`${MIG}/002_create_trips_and_reservations.sql`, '2025-09-04', `CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  region text NOT NULL,
  difficulty smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  base_price_cents integer NOT NULL
);

CREATE TABLE departures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  date date NOT NULL,
  capacity smallint NOT NULL,
  guide_id uuid REFERENCES users(id)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL REFERENCES departures(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  seats smallint NOT NULL CHECK (seats BETWEEN 1 AND 12),
  status text NOT NULL,
  price_cents integer NOT NULL,
  payment_id text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
`)
txt(`${MIG}/003_create_payments.sql`, '2025-10-08', `CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  reason text,
  status text NOT NULL,
  provider_refund_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
`)
txt(`${MIG}/004_add_processed_events.sql`, '2025-11-20', `-- Webhook idempotency: one row per payment provider event we have handled.
CREATE TABLE processed_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Keep 90 days of event ids; the provider never retries older events.
CREATE INDEX processed_events_processed_at ON processed_events (processed_at);
`)
txt(`${MIG}/005_add_waitlist.sql`, '2026-03-05', `CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL REFERENCES departures(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  seats smallint NOT NULL,
  position serial,
  status text NOT NULL DEFAULT 'waiting',
  offer_expires_at timestamptz
);
`)
txt(`${MIG}/006_index_reservations_trip_status.sql`, '2026-03-24', `-- The availability query filtered reservations by departure and status with a sequential scan
-- (about 900 ms on production data). This index brings it down to about 40 ms.
CREATE INDEX CONCURRENTLY reservations_departure_status ON reservations (departure_id, status);
`)

txt(
  `${REPO}/scripts/deploy.sh`,
  '2026-01-28',
  `#!/usr/bin/env bash
# Deploys tidewater-booking with a blue/green switch.
# Usage: scripts/deploy.sh staging|production
set -euo pipefail

ENVIRONMENT="$1"
TAG="$(git rev-parse --short HEAD)"
IMAGE="registry.tidewaterlabs.se/booking:$TAG"

if [[ "$ENVIRONMENT" == "production" && "$(git rev-parse --abbrev-ref HEAD)" != "main" ]]; then
  echo "Production deploys only from main" >&2
  exit 1
fi

docker build -t "$IMAGE" .
docker push "$IMAGE"

# Run database migrations before switching traffic. Migrations must be backwards compatible.
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "docker run --rm --env-file /etc/booking.env $IMAGE npm run migrate"

# Start the idle colour, wait for the health check, then switch the load balancer.
IDLE="$(ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" cat /etc/booking/idle-colour)"
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-start $IDLE $IMAGE"
for i in $(seq 1 30); do
  if curl -fsS "https://$IDLE.$ENVIRONMENT.tidewaterlabs.se/health" > /dev/null; then
    ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-switch $IDLE"
    echo "Deployed $TAG to $ENVIRONMENT ($IDLE)"
    exit 0
  fi
  sleep 2
done

echo "Health check failed; traffic stays on the old colour. Rolling back." >&2
ssh "deploy@$ENVIRONMENT.tidewaterlabs.se" "booking-stop $IDLE"
exit 1
`
)

txt(
  `${REPO}/scripts/backup-db.sh`,
  '2025-12-03',
  `#!/usr/bin/env bash
# Nightly database backup: dump, compress, upload to object storage, keep 35 days.
set -euo pipefail

STAMP="$(date +%Y-%m-%d)"
FILE="/var/backups/booking-$STAMP.sql.gz"

pg_dump --no-owner "$DATABASE_URL" | gzip -9 > "$FILE"
aws s3 cp "$FILE" "s3://tidewater-backups/booking/$STAMP.sql.gz" --storage-class STANDARD_IA

# Delete local copies older than 3 days and remote copies older than 35 days.
find /var/backups -name 'booking-*.sql.gz' -mtime +3 -delete
aws s3 ls s3://tidewater-backups/booking/ | awk '{print $4}' | while read -r name; do
  day="$(basename "$name" .sql.gz)"
  if [[ "$(date -d "$day" +%s)" -lt "$(date -d '35 days ago' +%s)" ]]; then
    aws s3 rm "s3://tidewater-backups/booking/$name"
  fi
done
`
)

txt(
  `${REPO}/config/staging.yaml`,
  '2026-01-28',
  `port: 4010
payment:
  webhookToleranceSeconds: 300
smtp:
  host: smtp.staging.tidewaterlabs.se
  port: 587
  from: "Bookings (staging) <bookings@staging.tidewaterlabs.se>"
sms:
  provider: textbridge.example
  sender: TIDEWATER
features:
  waitlist: true
  groupBookings: true
  pickupPoints: false
`
)
txt(
  `${REPO}/config/production.yaml`,
  '2026-01-28',
  `port: 4010
payment:
  webhookToleranceSeconds: 300
smtp:
  host: smtp.tidewaterlabs.se
  port: 587
  from: "Acme Outdoor bookings <bookings@acme-outdoor.se>"
sms:
  provider: textbridge.example
  sender: ACMEOUTDOOR
features:
  waitlist: true
  groupBookings: false
  pickupPoints: false
`
)

txt(
  `${REPO}/tests/reservations.test.ts`,
  '2026-03-11',
  `import { describe, it, expect } from 'vitest'
import { holdSeats } from '../src/booking/reservations.js'
import { seedDeparture, seedCustomer } from './helpers.js'

describe('holdSeats', () => {
  it('lets only one of two parallel checkouts take the last seat', async () => {
    const departure = await seedDeparture({ capacity: 1 })
    const [a, b] = await Promise.all([seedCustomer(), seedCustomer()])
    const results = await Promise.allSettled([holdSeats(departure, a, 1), holdSeats(departure, b, 1)])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  })

  it('rejects groups larger than 12', async () => {
    const departure = await seedDeparture({ capacity: 20 })
    await expect(holdSeats(departure, await seedCustomer(), 13)).rejects.toThrow('1 to 12 people')
  })
})
`
)
txt(
  `${REPO}/tests/webhooks.test.ts`,
  '2025-11-20',
  `import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySignature } from '../src/payments/webhooks.js'

const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? 'test-secret'
const sign = (body: string, t: number) => 't=' + t + ',v1=' + createHmac('sha256', secret).update(t + '.' + body).digest('hex')

describe('verifySignature', () => {
  const body = '{"id":"evt_1","type":"payment.succeeded"}'
  it('accepts a fresh, correct signature', () => {
    const t = Math.floor(Date.now() / 1000)
    expect(verifySignature(Buffer.from(body), sign(body, t))).toBe(true)
  })
  it('rejects a replayed request older than five minutes', () => {
    const t = Math.floor(Date.now() / 1000) - 600
    expect(verifySignature(Buffer.from(body), sign(body, t))).toBe(false)
  })
})
`
)
txt(
  `${REPO}/tests/pricing.test.ts`,
  '2026-03-06',
  `import { describe, it, expect } from 'vitest'
import { refundShare } from '../src/booking/cancellations.js'

const departure = new Date('2026-07-10T08:00:00Z')
const daysBefore = (d: number) => new Date(departure.getTime() - d * 86400000)

describe('refundShare', () => {
  it('refunds everything more than a week ahead', () => expect(refundShare(departure, daysBefore(8))).toBe(1))
  it('refunds half between a week and two days', () => expect(refundShare(departure, daysBefore(3))).toBe(0.5))
  it('refunds nothing in the last 48 hours', () => expect(refundShare(departure, daysBefore(1))).toBe(0))
  it('always refunds operator cancellations', () => expect(refundShare(departure, daysBefore(0), true)).toBe(1))
})
`
)

txt(
  `${REPO}/docs/ARCHITECTURE.md`,
  '2026-03-26',
  `# Architecture

One Node service (Express) in front of one Postgres database. No message queue: background work runs as cron jobs inside the service, and every job is safe to run twice.

## Booking flow
1. The customer picks a departure; the calendar calls GET /trips/:id/availability.
2. POST /trips/:id/holds places a 10 minute hold (row lock on the departure, see src/booking/reservations.ts).
3. The customer pays on the provider's hosted checkout page.
4. The provider calls our webhook; we verify the signature, record the event id and confirm the reservation.
5. A confirmation email goes out in the customer's language.

## Why no Redis
Postgres row locks are enough for our volume (peak 30 checkouts per minute in June) and one less system to run.

## Authentication
Short-lived JWT access tokens (15 minutes) and rotating refresh tokens (30 days). See ADR 0003.
`
)
txt(
  `${REPO}/docs/adr/0001-postgres-over-mongodb.md`,
  '2025-09-01',
  `# ADR 0001: Postgres instead of MongoDB

Status: accepted, September 2025

## Context
Bookings, payments and refunds must stay consistent. A seat must never be sold twice.

## Decision
Use Postgres 16. Use transactions and row locks for seat holds. Money is stored as integer cents.

## Consequences
Schema changes need migrations. The team already knows SQL, so this is cheap.
`
)
txt(
  `${REPO}/docs/adr/0002-idempotent-webhooks.md`,
  '2025-11-20',
  `# ADR 0002: Idempotent payment webhooks

Status: accepted, November 2025, after the webhook outage on 18 November

## Context
The payment provider retries a webhook until it gets a 2xx response, for up to three days. After the outage it resent hundreds of events at once. Handling an event twice would send two confirmation emails or refund a customer twice.

## Decision
Every event id is inserted into processed_events before the event is handled. If the insert conflicts, we answer 200 and do nothing. Refund calls to the provider also carry an idempotency key.

## Consequences
The table grows by about 2,000 rows a month; rows older than 90 days are deleted.
`
)
txt(
  `${REPO}/docs/adr/0003-refresh-token-rotation.md`,
  '2026-02-20',
  `# ADR 0003: Rotate refresh tokens and detect reuse

Status: accepted, February 2026

## Context
Guides stay signed in to the admin app on shared tablets at trip bases. A stolen refresh token used to be valid for 30 days.

## Decision
Each refresh token can be used once. Using it returns a new access token and a new refresh token in the same family. If a used token is presented again, the whole family is revoked and the user must sign in again.

## Consequences
Two browser tabs refreshing at the same moment can log a user out. We accept this; the admin app refreshes from one place only.
`
)
txt(
  `${REPO}/docs/runbooks/rotate-webhook-secret.md`,
  '2025-11-25',
  `# Runbook: rotate the payment webhook signing secret

1. In the payment provider dashboard, choose "roll secret" with a 24 hour overlap. Never choose "expire now".
2. Copy the new secret into the secrets manager as PAYMENT_WEBHOOK_SECRET for staging.
3. Deploy staging and send a test event from the dashboard. Check for "ok" in the logs.
4. Repeat for production.
5. After 24 hours the old secret stops working. Watch the signature failure alert for that hour.
`
)
txt(
  `${REPO}/web/checkout-form.js`,
  '2025-10-10',
  `// Client-side checks on the booking form before the customer is sent to the payment page.
const form = document.querySelector('#booking-form')
const seats = form.querySelector('input[name=seats]')
const phone = form.querySelector('input[name=phone]')
const timer = document.querySelector('#hold-timer')

const MAX_GROUP = 12
const HOLD_SECONDS = 10 * 60

form.addEventListener('submit', (event) => {
  const n = Number(seats.value)
  if (!Number.isInteger(n) || n < 1 || n > MAX_GROUP) {
    event.preventDefault()
    showError(seats, 'Choose between 1 and ' + MAX_GROUP + ' people')
  }
  if (!/^\\+?[0-9 ]{8,15}$/.test(phone.value)) {
    event.preventDefault()
    showError(phone, 'Enter a mobile number so the guide can reach you')
  }
})

// Shows the customer how long the seats are held for them.
function startHoldCountdown() {
  let left = HOLD_SECONDS
  const tick = setInterval(() => {
    left -= 1
    timer.textContent = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0')
    if (left <= 0) {
      clearInterval(tick)
      timer.textContent = 'Your hold has expired. Please pick the date again.'
    }
  }, 1000)
}

function showError(input, message) {
  input.setAttribute('aria-invalid', 'true')
  input.nextElementSibling.textContent = message
}

startHoldCountdown()
`
)

// ---------- code/booking-analytics: small Python reporting scripts ----------
const AN = 'code/booking-analytics'
txt(`${AN}/README.md`, '2026-02-02', `# booking-analytics

Python scripts that read a nightly copy of the booking database and produce CSV reports for trip operators and clinics.

- no_show_report.py: share of booked people who did not turn up, per trip and weekday
- revenue_by_month.py: revenue, refunds and net revenue per month
- queries/top_routes.sql: most booked trips over the last 12 months

Run with: python no_show_report.py --since 2026-01-01
`)
txt(`${AN}/requirements.txt`, '2026-02-02', `psycopg[binary]==3.2.3
pandas==2.2.3
python-dateutil==2.9.0
`)
txt(
  `${AN}/no_show_report.py`,
  '2026-02-02',
  `"""No-show report: which trips and weekdays have the most people who booked but did not turn up."""
import argparse
import pandas as pd
import psycopg

from utils.dates import parse_since

QUERY = """
SELECT t.name AS trip, d.date, r.seats, r.attended
FROM reservations r
JOIN departures d ON d.id = r.departure_id
JOIN trips t ON t.id = d.trip_id
WHERE r.status = 'confirmed' AND d.date >= %(since)s AND d.date < now()
"""


def no_show_rates(df: pd.DataFrame) -> pd.DataFrame:
    df = df.assign(weekday=pd.to_datetime(df["date"]).dt.day_name(), missed=df["seats"] - df["attended"])
    grouped = df.groupby(["trip", "weekday"]).agg(booked=("seats", "sum"), missed=("missed", "sum"))
    grouped["no_show_rate"] = (grouped["missed"] / grouped["booked"]).round(3)
    return grouped.sort_values("no_show_rate", ascending=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="90 days ago")
    parser.add_argument("--out", default="no_show_report.csv")
    args = parser.parse_args()
    with psycopg.connect() as conn:
        df = pd.read_sql(QUERY, conn, params={"since": parse_since(args.since)})
    no_show_rates(df).to_csv(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
`
)
txt(
  `${AN}/revenue_by_month.py`,
  '2026-02-03',
  `"""Monthly revenue report: gross bookings, refunds and net revenue in euro."""
import pandas as pd
import psycopg

GROSS = "SELECT date_trunc('month', confirmed_at) AS month, SUM(price_cents) AS gross FROM reservations WHERE status IN ('confirmed', 'cancelled') GROUP BY 1"
REFUNDS = "SELECT date_trunc('month', created_at) AS month, SUM(amount_cents) AS refunded FROM refunds WHERE status = 'completed' GROUP BY 1"


def revenue_table(conn) -> pd.DataFrame:
    gross = pd.read_sql(GROSS, conn).set_index("month")
    refunds = pd.read_sql(REFUNDS, conn).set_index("month")
    table = gross.join(refunds, how="left").fillna(0)
    table["net"] = table["gross"] - table["refunded"]
    return (table / 100).round(2)


if __name__ == "__main__":
    with psycopg.connect() as conn:
        print(revenue_table(conn).to_string())
`
)
txt(
  `${AN}/utils/dates.py`,
  '2026-02-02',
  `from datetime import date, timedelta
import re


def parse_since(text: str) -> date:
    """Accepts an ISO date (2026-01-01) or a phrase like '90 days ago'."""
    m = re.fullmatch(r"(\\d+) days ago", text.strip())
    if m:
        return date.today() - timedelta(days=int(m.group(1)))
    return date.fromisoformat(text)
`
)
txt(
  `${AN}/queries/top_routes.sql`,
  '2026-02-04',
  `-- Most booked trips in the last 12 months, with average group size.
SELECT t.name,
       t.region,
       COUNT(*) AS bookings,
       SUM(r.seats) AS people,
       ROUND(AVG(r.seats), 1) AS avg_group_size
FROM reservations r
JOIN departures d ON d.id = r.departure_id
JOIN trips t ON t.id = d.trip_id
WHERE r.status = 'confirmed'
  AND d.date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY t.name, t.region
ORDER BY people DESC
LIMIT 20;
`
)

// ---------- code/home-automation: a hobby project ----------
txt(
  'code/home-automation/README.md',
  '2025-11-02',
  `# home-automation

Scripts for the flat: heating schedule for the Ilma heat pump and a plant watering reminder.
Runs on a Raspberry Pi in the hallway cupboard.
`
)
txt(
  'code/home-automation/thermostat_schedule.py',
  '2025-11-02',
  `"""Sets the heat pump target temperature by time of day. Lower at night and when nobody is home."""
from datetime import datetime
import yaml

from heatpump import IlmaClient


def target_for(now: datetime, schedule: dict, away: bool) -> float:
    if away:
        return schedule["away"]
    hour = now.hour
    if hour < 6 or hour >= 23:
        return schedule["night"]
    if now.weekday() < 5 and 9 <= hour < 16:
        return schedule["workday"]
    return schedule["home"]


def main() -> None:
    with open("config.yaml") as f:
        cfg = yaml.safe_load(f)
    client = IlmaClient(cfg["heatpump"]["host"])
    client.set_target(target_for(datetime.now(), cfg["schedule"], client.everyone_away()))


if __name__ == "__main__":
    main()
`
)
txt(
  'code/home-automation/config.yaml',
  '2025-11-02',
  `heatpump:
  host: 192.168.1.40
schedule:
  night: 18.5
  workday: 19.0
  home: 21.5
  away: 16.0
plants:
  monstera: 7
  basil: 2
`
)
// ---------- notes ----------
const weekly = (week, days, extra = '') =>
  `Weekly planning - week ${week}
${days.join('\n')}
${extra}`
txt('notes/2024/2024-01-15 goals for 2024.md', '2024-01-15', `# Goals for 2024

1. Land two clients outside Uppsala so I am not dependent on one local network.
2. Raise my day rate from EUR 650 to EUR 720 by the summer.
3. Stop working weekends. Fridays after 15:00 are for admin only.
4. Write four blog posts about service design for small businesses.
5. Take the product owner course in the autumn.
`)
txt('notes/2024/2024-03-12 design meetup notes.md', '2024-03-12', `# Design meetup Uppsala - 12 March 2024

Talk 1: "Accessible forms" by a designer from the county council. Error messages must say how to fix the problem, not just that something is wrong. Placeholder text is not a label. Contrast of at least 4.5:1 for body text.

Talk 2: "Selling research to small clients". Show one video clip of a real customer struggling; it beats any slide.

People to follow up: Hana Kobayashi (Orchid Logistics, mentioned they need dashboards), Johan from the bakery co-op.
`)
txt('notes/2024/2024-05-20 weekly planning.txt', '2024-05-20', weekly(21, ['Monday: blog post on accessible forms, first draft.', 'Tuesday: portfolio update, add the bike kitchen case.', 'Wednesday: coffee with Hana (Orchid).', 'Thursday: bookkeeping for April.', 'Friday: product owner course application.']))
txt('notes/2024/2024-08-26 fernhill intro call.md', '2024-08-26', `# Fernhill Library Trust - intro call (26 August 2024)

Owen Price (head of digital) found me through the bike kitchen case study.
- Nine libraries in County Wicklow, one catalogue, old LibraSys system that goes out of support in March 2025.
- They chose OpenShelf already; they need someone to plan the migration and train staff.
- Budget is per day, around EUR 700. Trust board meets on 10 September.
- Owen worries most about the local history collections in Bray and Greystones.
Next: send a consulting agreement by 2 September.
`)
txt('notes/2024/2024-11-28 book notes - talking to customers.md', '2024-11-28', `# Book notes: talking to customers

- Ask about what people did last time, not what they would do in the future.
- Compliments are noise. "That sounds great" means nothing until someone pays or commits time.
- Avoid pitching during an interview. Keep the idea to yourself until the end.
- Good questions: "When did this last happen?", "What did you try?", "What did it cost you?"
- Write notes the same day, in their words.
`)
txt('notes/2024/2024-12-18 year review 2024.md', '2024-12-18', `# Year review 2024

Revenue: about EUR 61,000 (goal was 55,000).
Clients: Fernhill Library Trust (biggest), Uppsala Bike Kitchen, two small workshops.
What worked: the case study page brings in leads; Owen found me there.
What did not: I worked 9 weekends. Too many unpaid "quick calls".
Day rate reached EUR 720 in June.
For 2025: a rate card, fixed-fee proposals, and no calls without an agenda.
`)

txt('notes/2025/2025-01-20 weekly planning.txt', '2025-01-20', weekly(4, ['Monday: Fernhill training session in Bray (remote).', 'Tuesday: rate card 2025 final, send to the printer.', 'Wednesday: Larkspur first meeting, Gothenburg train 07:10.', 'Thursday: VAT return for Q4.', 'Friday: invoices and inbox.']))
txt('notes/2025/2025-03-11 orchid intro call.md', '2025-03-11', `# Orchid Logistics - intro call (11 March 2025)

Hana Kobayashi, operations manager. Three warehouses in Norrkoping.
- Shift leads spend Monday mornings building spreadsheets from StockPilot exports.
- They want screens on the warehouse floor showing how each shift is doing.
- Their biggest worry: pick accuracy fell to 98.7% after the peak season.
- Budget: "around 15k euro", decision by the managing director.
Next: workshop in April, then a statement of work.
`)
txt('notes/2025/2025-04-29 accountant meeting.md', '2025-04-29', `# Meeting with my accountant, Lena Berg (29 April 2025)

- Move from yearly to quarterly VAT returns now that revenue is above SEK 1 million.
- Preliminary tax: raise the monthly F-tax payment from SEK 9,800 to SEK 12,500 to avoid interest at year end.
- Keep all train tickets to Gothenburg for Larkspur; they are deductible travel.
- The laptop can be written off in one year since it costs under half a price base amount.
- Invoices to Fernhill (Ireland) are reverse charge: no Swedish VAT, but the client's VAT number must be on the invoice.
`)
txt('notes/2025/2025-06-16 weekly planning.txt', '2025-06-16', weekly(25, ['Monday: Orchid dashboard sketches, round two.', 'Tuesday: Harbor & Pine copy for the German emails.', 'Wednesday: midsummer prep, buy herring and strawberries.', 'Thursday: half day, Orchid SOW revision (refresh every 15 minutes).', 'Friday: Midsummer Eve, off.']))
txt('notes/2025/2025-09-30 workshop ideas.md', '2025-09-30', `# Workshop formats I could sell

- "Map your booking journey" (half day): staff map every step a customer takes, from search to the day after the visit. Output: top five drop-off points.
- "No-show clinic" (2 hours): for clinics, salons and studios. Look at the data, write reminder copy together.
- "Dashboard in a day": pick three numbers that matter, sketch the screen, agree on definitions.
Price idea: from EUR 1,900 per workshop, including a written summary.
`)
txt('notes/2025/2025-12-15 year review 2025.md', '2025-12-15', `# Year review 2025

Revenue: about EUR 86,000. Six clients, none bigger than a third of revenue.
Best project: Orchid dashboards, used every day on the warehouse floor.
Hardest: Harbor & Pine, three versions of the proposal before we agreed on price.
Lesson: price fixed fees with milestones the client can see.
Worked 3 weekends (down from 9).
For 2026: raise the day rate to EUR 780, finish Bluebird, win one bigger booking project.
`)

txt('notes/2026/2026-01-07 goals for 2026.md', '2026-01-07', `# Goals for 2026

1. One anchor client with a project over EUR 25,000 (Acme looks likely).
2. Day rate EUR 780; retainer offer for past clients.
3. Speak at two events.
4. Four weeks of real holiday, including Japan in April.
5. Hire a part-time bookkeeper so Friday afternoons are free.
`)
txt('notes/2026/2026-03-03 weekly planning.txt', '2026-03-03', weekly(10, ['Monday: Tidewater architecture sync prep, write down the double booking problem.', 'Tuesday: Bluebird February no-show report.', 'Wednesday: Acme agreement v2 comments.', 'Thursday: kickoff workshop materials (sticky notes, printed journey).', 'Friday: invoices, inbox zero.']))
txt('notes/2026/2026-03-10 weekly planning.txt', '2026-03-10', weekly(11, ['Monday: send invoice 2026-019 to Priya (40% upfront).', 'Tuesday: dentist 14:00. Call the accountant about the VAT return.', 'Wednesday: blog post about pricing small consulting projects, second draft.', 'Thursday: Acme calendar prototype testing with five customers.', 'Friday: plan next week.']))
txt('notes/2026/2026-03-17 coworking meetup notes.md', '2026-03-17', `# Coworking meetup - 17 March 2026

Monthly breakfast at Kontoret. Topic: getting paid on time.
- Erik (copywriter) sends invoices the same day work is approved and offers a 2% discount for payment within 7 days. Most clients take it.
- Two people use automatic reminders from their accounting software at day 3 and day 10 after the due date.
- Nobody charges late payment interest in practice, but writing it in the contract makes clients pay faster.
- Idea for me: put the milestone invoice in the same email as the acceptance confirmation.
Next meetup: 14 April, topic "saying no to scope creep".
`)
txt('notes/2026/2026-03-25 tax advisor meeting.md', '2026-03-25', `# Meeting with Lena Berg, accountant (25 March 2026)

- 2025 tax return: deadline 2 May. Lena needs the receipts for the laptop, the coworking desk and the train tickets by 15 April.
- Home office deduction: I rent a desk at Kontoret, so the flat-rate home office deduction does not apply any more.
- Q4 2025 VAT was paid on 12 February, SEK 18,420.
- Consider a limited company (aktiebolag) when profit stays above SEK 600,000 two years in a row.
- Bookkeeper: Lena can recommend someone at SEK 650 per hour, about 4 hours a month.
`)
txt('notes/2026/2026-04-21 weekly planning.txt', '2026-04-21', weekly(17, ['Monday: back from Japan, inbox triage.', 'Tuesday: Bluebird phase 2 kickoff.', 'Wednesday: Acme group booking flow sketches.', 'Thursday: invoice 2026-040 (Bluebird phase 2, 50%).', 'Friday: tax receipts to Lena (late!).']))
txt('notes/2026/2026-06-09 summer plans.md', '2026-06-09', `# Summer plans 2026

- Office closed 6 July to 2 August. Auto-reply points clients to Tidewater for urgent booking issues.
- Acme handover is done (29 May). Warranty period of 90 days runs until late August.
- Two weeks at the cabin in Jamtland, one week sailing with Ida in the archipelago.
- Before leaving: invoice the Bluebird phase 2 launch and update the CV and the website case studies.
`)
txt('notes/2026/2026-08-18 pipeline review.md', '2026-08-18', `# Pipeline review - August 2026

| Lead | Value (EUR) | Chance | Next step |
|---|---|---|---|
| Acme phase 2 (gift cards, multi-currency) | 18,000 | 60% | Proposal by 1 Sept |
| Harbor & Pine retainer | 2,850 per month | 50% | Call with Lucia 26 Aug |
| Orchid returns portal | 9,000 | 30% | Waiting for budget |
| Uppsala school meals booking | 12,000 | 20% | Tender opens in October |

Weighted pipeline: about EUR 20,000. Autumn looks fine but not full.
`)
txt('notes/2026/2026-09-08 weekly planning.txt', '2026-09-08', weekly(37, ['Monday: Acme phase 2 proposal, final read.', 'Tuesday: Harbor & Pine retainer terms.', 'Wednesday: talk slides for the autumn design meetup.', 'Thursday: Q2 VAT return check with Lena.', 'Friday: invoices.']))
txt('notes/ideas/booking-flow-improvements.md', '2026-02-05', `# Ideas: making online booking less painful

Collected from Acme, Bluebird and Harbor & Pine.
- Show how many spots are left ("3 spots left") instead of just "available". People decide faster.
- Hold the seat while the customer pays and show a countdown. Nothing is worse than paying and then being told the trip is full.
- Let one person book for a whole group, and collect names later.
- Offer a waitlist instead of a dead end when something is sold out.
- Confirmation emails must arrive within a minute and in the customer's language.
- Reminders two days before, with the meeting point. Most "where do we meet?" phone calls go away.
- Make moving a booking as easy as cancelling it.
`)
txt('notes/ideas/newsletter-topics.md', '2025-10-21', `# Newsletter topics

- Why your confirmation email lands in spam (SPF, DKIM, a real reply-to address).
- Three numbers every small booking business should watch: conversion, no-show rate, refunds.
- Fixed fee or day rate? What I learned from 20 proposals.
- How a bakery cut bread waste with pre-orders.
`)

// ---------- finance: invoices ----------
function invoice({ no, date, client, address, lines, vat, due = 30, ref }) {
  const total = lines.reduce((s, [, a]) => s + a, 0)
  const fmt = (n) => n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const vatLine = vat === 'reverse' ? 'VAT: reverse charge, Article 196 Directive 2006/112/EC' : `VAT 25%: EUR ${fmt(total * 0.25)}`
  const grand = vat === 'reverse' ? total : total * 1.25
  return `INVOICE ${no}
Maya Lindqvist Consulting, Uppsala, Sweden. VAT no. SE870412441701
Date: ${date}
Bill to: ${client}
${address}${ref ? `\nYour reference: ${ref}` : ''}

${lines.map(([d, a]) => `${d.padEnd(64)} EUR ${fmt(a)}`).join('\n')}

Subtotal: EUR ${fmt(total)}
${vatLine}
Total due: EUR ${fmt(grand)}

Payment due within ${due} days. Bank transfer to IBAN SE45 5000 0000 0583 9825 7466, BIC ESSESESS.
Please quote the invoice number with your payment.
`
}
const INV = 'finance/invoices'
const FERN = ['Fernhill Library Trust', 'Main Street, Bray, Co. Wicklow, Ireland. VAT no. IE6388047V']
const invoices = [
  ['2024', '2024-031', '2024-10-31', FERN, [['Consulting days, October 2024: 15 days at EUR 680', 10200]], 'reverse', 'txt'],
  ['2024', '2024-038', '2024-11-29', FERN, [['Consulting days, November 2024: 14 days at EUR 680', 9520], ['Travel expenses: Dublin, 12-13 November', 412]], 'reverse', 'txt'],
  ['2024', '2024-044', '2024-12-20', FERN, [['Consulting days, December 2024: 6 days at EUR 680', 4080]], 'reverse', 'pdf'],
  ['2025', '2025-007', '2025-03-31', FERN, [['Consulting days, January to March 2025: 6 days at EUR 680 (final)', 4080]], 'reverse', 'txt'],
  ['2025', '2025-052', '2025-05-30', ['Larkspur Architects AB', 'Vastra Hamngatan 9, Gothenburg'], [['Drawing archive search: 18 days at EUR 750', 13500]], 25, 'pdf'],
  ['2025', '2025-071', '2025-06-02', ['Harbor & Pine Hotels AB', 'Strandgatan 3, Visby'], [['Pre-arrival guest journey: 30% on signing', 4950]], 25, 'txt'],
  ['2025', '2025-088', '2025-07-04', ['Orchid Logistics AB', 'Industrigatan 41, Norrkoping'], [['Warehouse KPI dashboards: milestone 1, design sign-off (30%)', 4650]], 25, 'txt'],
  ['2025', '2025-096', '2025-08-08', ['Harbor & Pine Hotels AB', 'Strandgatan 3, Visby'], [['Pre-arrival guest journey: 40%, journey live in Visby', 6600]], 25, 'txt'],
  ['2025', '2025-104', '2025-08-15', ['Orchid Logistics AB', 'Industrigatan 41, Norrkoping'], [['Warehouse KPI dashboards: milestone 2, first three dashboards live (40%)', 6200]], 25, 'txt'],
  ['2025', '2025-109', '2025-09-01', ['Orchid Logistics AB', 'Industrigatan 41, Norrkoping'], [['Warehouse KPI dashboards: milestone 3, final go-live (30%)', 4650]], 25, 'pdf'],
  ['2025', '2025-112', '2025-09-15', ['Kestrel Bakery Co-op', 'Svartbacksgatan 22, Uppsala'], [['Online pre-orders: 50% on signing', 3600]], 25, 'txt'],
  ['2025', '2025-115', '2025-10-03', ['Harbor & Pine Hotels AB', 'Strandgatan 3, Visby'], [['Pre-arrival guest journey: 30% at handover', 4950]], 25, 'txt'],
  ['2025', '2025-118', '2025-11-10', ['Bluebird Dental Clinics AB', 'Kungsgatan 57, Uppsala'], [['Patient reminder service: kickoff instalment (50%)', 4750]], 25, 'txt'],
  ['2025', '2025-121', '2025-11-14', ['Kestrel Bakery Co-op', 'Svartbacksgatan 22, Uppsala'], [['Online pre-orders: 50% on launch', 3600]], 25, 'txt'],
  ['2026', '2026-004', '2026-01-26', ['Bluebird Dental Clinics AB', 'Kungsgatan 57, Uppsala'], [['Patient reminder service: acceptance instalment (50%)', 4750]], 25, 'txt'],
  ['2026', '2026-011', '2026-02-27', ['Bluebird Dental Clinics AB', 'Kungsgatan 57, Uppsala'], [['Support January-February 2026: 6.5 hours at EUR 95', 617.5], ['SMS costs passed through, 1,964 messages', 98.2]], 25, 'txt'],
  ['2026', '2026-019', '2026-03-10', ['Acme Outdoor Co. AB', 'Storgatan 14, Ostersund'], [['Booking system redesign: 40% on signing', 10400]], 25, 'pdf'],
  ['2026', '2026-033', '2026-04-17', ['Acme Outdoor Co. AB', 'Storgatan 14, Ostersund'], [['Booking system redesign: milestone 1, availability calendar live (30%)', 7800]], 25, 'txt'],
  ['2026', '2026-040', '2026-04-23', ['Bluebird Dental Clinics AB', 'Kungsgatan 57, Uppsala'], [['Reminders phase 2: 50% on signing', 3200]], 25, 'txt'],
  ['2026', '2026-052', '2026-06-01', ['Acme Outdoor Co. AB', 'Storgatan 14, Ostersund'], [['Booking system redesign: milestone 2, final handover (30%)', 7800]], 25, 'pdf'],
  ['2026', '2026-058', '2026-06-05', ['Bluebird Dental Clinics AB', 'Kungsgatan 57, Uppsala'], [['Reminders phase 2: 50% on launch', 3200]], 25, 'txt']
]
for (const [year, no, date, [client, address], lines, vat, ext] of invoices) {
  const ref = client.startsWith('Acme') ? 'Priya Nair, PO 4471' : undefined
  const text = invoice({ no, date, client, address, lines, vat, ref, due: client.startsWith('Acme') && no !== '2026-019' ? 20 : 30 })
  const rel = `${INV}/${year}/invoice-${no}.${ext}`
  if (ext === 'pdf') pdfFile(rel, date, `Invoice ${no}`, text)
  else txt(rel, date, text)
}
distractor(`${INV}/2025/invoice-2025-118.txt`, `${INV}/2025/invoice-2025-121.txt`, 'same invoice template, different client and amount')

txt(`${INV}/2026/payment-reminder-2026-033.txt`, '2026-05-12', `Subject: Friendly reminder - invoice 2026-033

Hi Priya,

Invoice 2026-033 for milestone 1 of the booking system redesign (EUR 9,750.00 including VAT) was due on 7 May. I have not seen the payment yet. Could you check whether it is on its way?

As agreed in the services agreement, invoices are payable within 20 days.

Best regards,
Maya
`)

// ---------- finance: receipts, tax, budget ----------
txt('finance/receipts/2025-08-22 ThinkBook laptop order.txt', '2025-08-22', `Order confirmation - Elkedja Online
Order number: EK-5512-90731
Order date: 2025-08-22

ThinkBook 14 Gen 7 laptop, 16 GB RAM, 1 TB SSD     SEK 13,490
Extended warranty: 3 years on-site service         SEK 1,290
  (purchased separately, ends 2028-08-22)
USB-C dock                                         SEK 1,190
Total incl. VAT                                    SEK 15,970

Return window: 30 days from delivery.
Delivered to: Maya Lindqvist, Svartbacksgatan 8, Uppsala.
`)
txt('finance/receipts/office-chair-2024-03.txt', '2024-03-18', `Receipt - Sitta Kontorsmobler, Uppsala
Date: 2024-03-18

Sitta Ergo 300 office chair, black fabric      SEK 6,950
Armrest upgrade                                 SEK 450
Total incl. VAT 25%                             SEK 7,400

Warranty: 10 years on the frame and mechanism, 2 years on fabric.
`)
txt('finance/receipts/monitor-2025-01.txt', '2025-01-09', `Receipt - Elkedja Online
Order date: 2025-01-09
Order number: EK-4120-11873

27 inch USB-C monitor, 2560x1440                SEK 3,990
Total incl. VAT                                  SEK 3,990
Warranty: 3 years. Dead pixel guarantee for 30 days.
`)
txt('finance/receipts/coworking-membership-2026.txt', '2026-01-02', `Kontoret Uppsala - membership confirmation
Member: Maya Lindqvist
Plan: Flex desk, 2026
Price: SEK 2,400 per month excl. VAT, invoiced quarterly in advance
Includes: 24/7 access, coffee, 4 hours of meeting room per month, monthly breakfast meetup
Notice period: 1 month
`)
txt('finance/receipts/train-tickets-2025-03-03.txt', '2025-03-03', `Booking confirmation - rail
Booking ref: QX7PL2
Traveller: Maya Lindqvist
Outbound: Uppsala C 07:10 - Goteborg C 11:02, 3 March 2025, 2nd class, seat 34
Return: Goteborg C 17:05 - Uppsala C 20:58, 3 March 2025, 2nd class, seat 61
Total paid: SEK 1,186
`)
txt('finance/tax/VAT-return-Q4-2025-notes.md', '2026-02-10', `# VAT return Q4 2025 (October to December)

Output VAT on Swedish clients: SEK 21,610
Input VAT on purchases (coworking, software, train tickets): SEK 3,190
VAT to pay: SEK 18,420
Due date: 12 February 2026. Paid from the business account on 10 February.

Reminder: Fernhill invoices are reverse charge and go in box 39, not in output VAT.
`)
txt('finance/tax/deductions-2025.md', '2026-03-28', `# Deductible costs 2025

- Coworking desk at Kontoret: SEK 28,800
- ThinkBook laptop and dock (written off in one year): SEK 11,800 excl. VAT
- Monitor: SEK 3,192 excl. VAT
- Train tickets for Larkspur (6 trips): SEK 6,940
- Software subscriptions (design tool, accounting, password manager): SEK 9,450
- Mobile phone: 50% business use
- Professional indemnity premium: SEK 4,320
- Books and courses: SEK 2,100
No home office deduction this year because I rent a desk.
`)
txt('finance/tax/year-end-checklist.md', '2024-12-27', `# Year-end checklist

- [ ] Send all December invoices before the 31st.
- [ ] Reconcile the business account against the bookkeeping.
- [ ] Count unpaid invoices (accounts receivable).
- [ ] Collect receipts for equipment and travel.
- [ ] Check preliminary tax paid against expected profit.
- [ ] Back up the bookkeeping file to the external drive.
`)
txt('finance/budget-2026.md', '2026-01-09', `# Budget 2026

## Income target
EUR 110,000 (about 141 billable days at EUR 780).

## Fixed costs per month (SEK)
- Coworking desk: 2,400
- Software: 820
- Phone and internet: 540
- Professional indemnity cover: 360
- Bookkeeper (from April): 2,600

## Buffer
Keep three months of personal costs (SEK 105,000) in the savings account before paying any extra into investments.

## Big purchases planned
New phone in the autumn, about SEK 9,000.
`)
txt('finance/expenses-2025.csv', '2025-12-31', `date,category,description,amount_sek
2025-01-09,equipment,27 inch monitor,3990
2025-01-31,coworking,Kontoret flex desk Q1,7200
2025-02-03,software,design tool annual plan,3120
2025-03-03,travel,train Uppsala-Goteborg return (Larkspur),1186
2025-03-24,travel,train Uppsala-Goteborg return (Larkspur),1186
2025-04-01,insurance,professional indemnity premium,4320
2025-04-14,travel,train Uppsala-Goteborg return (Larkspur),1124
2025-04-30,coworking,Kontoret flex desk Q2,7200
2025-05-12,travel,train Uppsala-Goteborg return (Larkspur),1186
2025-06-02,travel,ferry Nynashamn-Visby return (Harbor & Pine),1460
2025-07-02,travel,ferry Nynashamn-Visby return (Harbor & Pine),1520
2025-07-31,coworking,Kontoret flex desk Q3,7200
2025-08-22,equipment,ThinkBook laptop with dock and extended warranty,15970
2025-09-10,courses,service blueprint online course,2100
2025-10-31,coworking,Kontoret flex desk Q4,7200
2025-11-03,software,accounting software annual plan,2880
2025-12-01,software,password manager team plan,1450
`)
// =====================================================================================================
// Persona 3: the household (manuals, receipts, recipes, travel, home)
// =====================================================================================================

function nordvikManual({ model, kind, install, use, care, warranty, errors }) {
  return `# Nordvik ${model} ${kind} - User Manual

## Safety
Read this manual before using the appliance. Keep children away from the appliance while it is running. Disconnect the power before cleaning or maintenance. Do not use the appliance if the power cable is damaged; it must be replaced by Nordvik service.

## Installation
${install}

## Everyday use
${use}

## Care and maintenance
${care}
\f
## Warranty
${warranty} The warranty is valid in the country of purchase. Keep your receipt as proof of the purchase date. Register your appliance at nordvik-home.example/register within 60 days to get an extra year of parts cover.

## Error codes
${errors}

## Service
Nordvik customer service: +46 8 555 019 40, weekdays 08:00-17:00. Have the model and serial number ready; they are on the label inside the door.
`
}
const DW450 = nordvikManual({
  model: 'DW-450',
  kind: 'Dishwasher',
  install: 'Connect the inlet hose to a cold water tap. Make sure the drain hose is not kinked and that its highest point is between 40 and 90 cm above the floor.',
  use: 'Load plates facing the centre and glasses in the upper basket. Use the Eco programme for normally soiled dishes; it takes 3 hours 50 minutes but uses the least water and energy. The Quick 30 programme is for lightly soiled dishes only.',
  care: 'Clean the filter at the bottom of the tub once a week. Refill rinse aid when the indicator lights up. In hard water areas, set the water softener to level 5 and use dishwasher salt.',
  warranty: 'The warranty period is 24 months from the date of purchase and covers manufacturing defects. The warranty does not cover damage from limescale; descale every three months in hard water areas.',
  errors: 'E1 - water inlet problem: check that the tap is open and the hose is not kinked. E4 - leak detected: turn off the water supply and contact service. E9 - the door is not closed properly.'
})
pdfFile('manuals/Nordvik_DW-450_Dishwasher_Manual.pdf', '2024-06-15', 'Nordvik DW-450 Manual', DW450)
copyOf('Downloads/Nordvik_DW-450_Dishwasher_Manual.pdf', '2024-06-14', 'manuals/Nordvik_DW-450_Dishwasher_Manual.pdf')
pdfFile(
  'manuals/Nordvik_WM-720_Washing_Machine_Manual.pdf',
  '2024-09-02',
  'Nordvik WM-720 Manual',
  nordvikManual({
    model: 'WM-720',
    kind: 'Washing Machine',
    install: 'Remove the four transport bolts from the back before first use and keep them for moving. Level the machine with the adjustable feet; it must not rock.',
    use: 'Sort laundry by colour and fabric. The 40-60 programme washes mixed cotton at the stated temperature with the lowest energy use. Do not load more than 9 kg of dry laundry. Wool should be washed on the Wool programme at 30 degrees and 800 rpm.',
    care: 'Clean the drain pump filter behind the small hatch at the bottom right every two months; a cloth on the floor catches the water. Run an empty 90 degree wash once a month to keep the drum fresh.',
    warranty: 'The warranty period is 24 months from the date of purchase for all parts, and 10 years for the inverter motor. It covers manufacturing defects.',
    errors: 'F05 - the water does not drain: clean the drain pump filter. F12 - the door lock does not engage: close the door firmly and restart. F21 - unbalanced load: spread out the laundry.'
  })
)
distractor('manuals/Nordvik_DW-450_Dishwasher_Manual.pdf', 'manuals/Nordvik_WM-720_Washing_Machine_Manual.pdf', 'same manual template, different appliance, codes and warranty')

pdfFile(
  'manuals/Brevia_EX3_Espresso_Machine_Manual.pdf',
  '2024-12-27',
  'Brevia EX3 Manual',
  `# Brevia EX3 Espresso Machine - Instructions

## Before first use
Rinse the water tank and fill it with fresh cold water. Run two empty cycles through the group head and the steam wand.

## Making espresso
Use 18 grams of finely ground coffee for a double shot. Tamp with even pressure. A good shot takes 25 to 30 seconds and gives about 36 grams of espresso. The pump delivers 15 bar.

## Milk
Purge the steam wand before and after steaming. Keep the tip just below the surface until the milk reaches about 60 degrees.

## Descaling
Descale every two months, or when the orange descale light comes on. Use Brevia descaling liquid diluted 1:4 with water and run the descale programme (hold both cup buttons for 5 seconds). Never use vinegar; it damages the seals.

## Warranty
Two years from the date of purchase. The warranty is void if the machine has not been descaled as described above.
`
)
pdfFile(
  'manuals/Kodo_RV-9_Robot_Vacuum_Quick_Start.pdf',
  '2025-02-14',
  'Kodo RV-9 Quick Start',
  `# Kodo RV-9 Robot Vacuum - Quick Start

1. Place the charging dock against a wall with 0.5 m free on each side and 1.5 m in front.
2. Charge the robot fully before the first run (about 4 hours).
3. Install the Kodo Home app and add the robot over 2.4 GHz Wi-Fi. 5 GHz networks are not supported.
4. The first run builds a map of your home. Open all doors and pick up cables and socks.
5. In the app you can draw no-go zones, for example around the dog bowl.

## Maintenance
Empty the dust bin after every run. Clean the main brush every week and replace it every 6 to 12 months. Replace the filter every 3 months.

## Status lights and errors
Blinking red with error 2: the main brush is stuck; remove hair and threads. Error 5: the bumper is stuck. Error 8: the robot cannot find the dock.

## Warranty
12 months on the robot, 6 months on the battery.
`
)
pdfFile(
  'manuals/Ilma_HP-12_Heat_Pump_User_Guide.pdf',
  '2025-10-20',
  'Ilma HP-12 User Guide',
  `# Ilma HP-12 Air-to-Air Heat Pump - User Guide

## Operating modes
Heat, cool, dry and fan. In heat mode the outdoor unit works down to minus 25 degrees. Below minus 15 degrees the heating capacity drops; keep a backup heater for very cold nights.

## Defrosting
In cold, humid weather the outdoor unit collects ice. The pump defrosts automatically for 5 to 10 minutes; the indoor fan stops and a white cloud of steam from the outdoor unit is normal.

## Filters
Vacuum the indoor filters every month during the heating season. A dirty filter can increase power use by up to 15%.

## Service
Have the heat pump serviced by an authorised installer every two years to keep the warranty valid.

## Error codes
A3: outdoor temperature sensor fault. A7: low refrigerant pressure; call the installer. H1: defrosting (not a fault).

## Warranty
5 years on the compressor, 3 years on other parts, from the installation date shown on the installation certificate.
`
)
await docxFile(
  'manuals/Velora_City_E-bike_Owner_Manual.docx',
  '2025-04-26',
  'Velora City E-bike Owner Manual',
  `# Velora City E-bike - Owner's Manual
## Battery
The 500 Wh battery gives a range of 60 to 90 km depending on assistance level, rider weight and hills. Charge it indoors at room temperature. A full charge takes about 5 hours. If you do not ride for a month, store the battery at 50 to 70% charge.
## Assistance levels
Eco, Tour, Sport and Turbo. The motor assists up to 25 km/h, as required by EU rules.
## Maintenance
Check tyre pressure every two weeks (3.5 to 4.5 bar). The first service is due after 300 km, then every 2,000 km or once a year. The belt drive does not need oil.
## Warranty
5 years on the frame, 2 years on the motor and battery. The battery warranty covers capacity loss below 60% within two years.
`
)
txt(
  'manuals/Linkbay_AX3000_router_setup.txt',
  '2024-02-10',
  `Linkbay AX3000 Wi-Fi router - quick setup

1. Connect the yellow WAN port to the fibre box with the supplied cable.
2. Wait for the light to turn steady white (about 2 minutes).
3. Join the network printed on the sticker under the router, then open http://192.168.50.1
4. Change the admin password and the Wi-Fi name and password.
5. Turn on automatic firmware updates.

Factory reset: hold the reset button for 10 seconds with a paper clip until the light blinks amber.
Guest network: Settings > Wireless > Guest, choose a separate password, limit to 2.4 GHz for smart plugs.
`
)
txt(
  'manuals/SafeNest_S2_smoke_alarm.txt',
  '2024-01-22',
  `SafeNest S2 smoke alarm

Mount on the ceiling, at least 50 cm from walls and lamps. One alarm per floor and one outside each bedroom.
Test the alarm once a month by pressing the test button until it sounds.
The sealed lithium battery lasts 10 years. When the alarm chirps once a minute, the battery is low and the whole alarm must be replaced.
Clean with a vacuum cleaner brush twice a year.
Warranty: 5 years.
`
)
txt(
  'manuals/Fjell_IH-60_induction_hob.md',
  '2026-05-10',
  `# Fjell IH-60 induction hob - notes from the manual

- Works only with magnetic pans. Test with a fridge magnet: if it sticks, the pan works.
- Boost (P) gives full power to one zone for 10 minutes, then drops back to level 9.
- Child lock: press and hold the key symbol for 3 seconds.
- Error U400: wrong mains voltage, call an electrician. Error E2: the hob is too hot, let it cool.
- Clean with a ceramic hob scraper and a little washing-up liquid. No steel wool.
- Warranty: 3 years if registered within 30 days.
`
)

// ---------- recipes ----------
function recipe({ title, serves, prep, cook, ingredients, method, notes }) {
  return `# ${title}
Serves: ${serves} | Prep: ${prep} | Cook: ${cook}

## Ingredients
${ingredients.map((i) => `- ${i}`).join('\n')}

## Method
${method.map((m, i) => `${i + 1}. ${m}`).join('\n')}

## Notes
${notes}

Oven temperatures are for a fan oven; add 20 degrees for a conventional oven. Measurements: 1 tbsp = 15 ml, 1 tsp = 5 ml.
`
}
const REC = 'personal/recipes'
txt(`${REC}/banana-bread.md`, '2024-04-14', recipe({
  title: 'Banana bread',
  serves: '1 loaf (10 slices)',
  prep: '15 minutes',
  cook: '60 minutes',
  ingredients: ['3 very ripe bananas', '75 g melted butter', '150 g brown sugar', '1 egg', '1 tsp vanilla sugar', '1 tsp baking soda', 'a pinch of salt', '200 g plain flour', '75 g chopped walnuts'],
  method: ['Heat the oven to 175 degrees and grease a 1.5 litre loaf tin.', 'Mash the bananas with a fork and stir in the melted butter.', 'Mix in the sugar, egg and vanilla sugar.', 'Sprinkle the baking soda and salt over the mixture, then fold in the flour and walnuts.', 'Bake for about 60 minutes, until a skewer comes out clean.'],
  notes: 'The browner the bananas, the better. Freezes well in slices.'
}))
txt(`${REC}/zucchini-bread.md`, '2025-08-17', recipe({
  title: 'Zucchini bread',
  serves: '1 loaf (10 slices)',
  prep: '20 minutes',
  cook: '55 minutes',
  ingredients: ['2 small zucchini (about 300 g), grated', '100 ml rapeseed oil', '150 g caster sugar', '2 eggs', '1 tsp cinnamon', '1 tsp baking powder', 'a pinch of salt', '220 g plain flour', 'zest of 1 lemon'],
  method: ['Heat the oven to 175 degrees and line a 1.5 litre loaf tin with baking paper.', 'Squeeze the grated zucchini in a clean towel to remove the water.', 'Whisk the oil, sugar and eggs until pale.', 'Fold in the zucchini, lemon zest, cinnamon, baking powder, salt and flour.', 'Bake for about 55 minutes, until a skewer comes out clean.'],
  notes: 'A good use for the glut from the balcony boxes in August. Keeps moist for four days.'
}))
distractor(`${REC}/banana-bread.md`, `${REC}/zucchini-bread.md`, 'same recipe card template, different recipe')
txt(`${REC}/lasagna.md`, '2024-11-30', recipe({
  title: 'Lasagna for six',
  serves: '6',
  prep: '40 minutes',
  cook: '45 minutes',
  ingredients: ['500 g minced beef', '1 onion and 2 garlic cloves', '2 tins crushed tomatoes', '50 g butter, 50 g flour, 700 ml milk for the bechamel', '12 lasagna sheets', '75 g grated parmesan'],
  method: ['Brown the mince with the onion and garlic, add the tomatoes and simmer for 40 minutes.', 'Make a bechamel with butter, flour and milk; season with nutmeg.', 'Layer pasta sheets, meat sauce and bechamel three times; finish with parmesan.', 'Bake at 190 degrees for 45 minutes and rest for 15 minutes before serving.'],
  notes: 'Good for a dinner party; can be assembled the day before.'
}))
txt(`${REC}/chicken-curry.md`, '2025-01-26', recipe({
  title: 'Weeknight chicken curry',
  serves: '4',
  prep: '15 minutes',
  cook: '30 minutes',
  ingredients: ['600 g chicken thighs, in pieces', '1 onion, 3 garlic cloves, a thumb of ginger', '2 tbsp curry paste', '400 ml coconut milk', '200 g spinach', 'lime and coriander to serve'],
  method: ['Fry the onion, garlic and ginger until soft.', 'Add the curry paste and fry for one minute.', 'Add the chicken and brown it, then pour in the coconut milk and simmer for 20 minutes.', 'Stir in the spinach, squeeze over lime and serve with rice.'],
  notes: 'Mild enough for kids if you use 1 tbsp paste.'
}))
txt(`${REC}/red-lentil-soup.md`, '2025-02-09', recipe({
  title: 'Red lentil soup',
  serves: '4',
  prep: '10 minutes',
  cook: '25 minutes',
  ingredients: ['250 g red lentils', '1 onion, 2 carrots', '1 tsp cumin, 1 tsp smoked paprika', '1.2 litres vegetable stock', '1 tin chopped tomatoes', 'juice of half a lemon'],
  method: ['Soften the onion and carrots in olive oil.', 'Add the spices, lentils, stock and tomatoes.', 'Simmer for 20 minutes until the lentils fall apart.', 'Blend, add lemon juice and season.'],
  notes: 'Cheap, vegan and freezes well. Top with yoghurt and chilli oil.'
}))
txt(`${REC}/cinnamon-buns.md`, '2024-10-04', recipe({
  title: 'Cinnamon buns (kanelbullar)',
  serves: '30 buns',
  prep: '2 hours including rising',
  cook: '8 minutes per tray',
  ingredients: ['50 g fresh yeast', '500 ml milk', '150 g butter', '100 g sugar', '1 tsp ground cardamom', '850 g flour', 'Filling: 150 g soft butter, 100 g sugar, 2 tbsp cinnamon', 'Egg and pearl sugar to finish'],
  method: ['Melt the butter, add the milk and warm to 37 degrees. Dissolve the yeast in it.', 'Add sugar, cardamom and most of the flour; knead for 10 minutes and let rise for 45 minutes.', 'Roll out, spread the filling, roll up and cut into 30 pieces.', 'Let rise for 30 minutes, brush with egg, sprinkle pearl sugar and bake at 225 degrees for 8 minutes.'],
  notes: 'For Cinnamon Bun Day on 4 October. Freeze half the batch on the day.'
}))
txt(`${REC}/gravlax.md`, '2024-12-20', recipe({
  title: 'Gravlax with mustard sauce',
  serves: '8 as a starter',
  prep: '20 minutes',
  cook: '48 hours in the fridge',
  ingredients: ['1 kg salmon fillet with skin, frozen first for 72 hours', '3 tbsp sugar, 2 tbsp salt, 1 tsp crushed white pepper', 'a large bunch of dill', 'Sauce: 2 tbsp sweet mustard, 1 tbsp Dijon, 1 tbsp sugar, 1 tbsp vinegar, 100 ml oil, chopped dill'],
  method: ['Cut the fillet in two halves. Mix sugar, salt and pepper and rub it into the flesh.', 'Put dill between the halves, flesh to flesh, wrap tightly and weigh down.', 'Leave in the fridge for 48 hours, turning every 12 hours.', 'Whisk the sauce, slowly adding the oil. Slice the salmon thinly.'],
  notes: 'Christmas Eve. Freezing first kills parasites, do not skip it.'
}))
txt(`${REC}/mushroom-risotto.md`, '2025-10-12', recipe({
  title: 'Mushroom risotto',
  serves: '4',
  prep: '10 minutes',
  cook: '30 minutes',
  ingredients: ['300 g arborio rice', '400 g mixed mushrooms (chanterelles if in season)', '1 shallot', '100 ml white wine', '1.2 litres hot chicken stock', '50 g butter, 60 g parmesan'],
  method: ['Fry the mushrooms hard in butter and set aside.', 'Soften the shallot, add the rice and toast for two minutes.', 'Add the wine, then the stock one ladle at a time, stirring, for about 18 minutes.', 'Stir in the mushrooms, butter and parmesan; rest for two minutes.'],
  notes: 'Chanterelles from the Jamtland cabin trip, August.'
}))
txt(`${REC}/chocolate-chip-cookies.md`, '2025-03-01', recipe({
  title: 'Chocolate chip cookies',
  serves: '20 cookies',
  prep: '15 minutes plus 1 hour chilling',
  cook: '11 minutes',
  ingredients: ['125 g browned butter', '100 g brown sugar, 75 g white sugar', '1 egg', '200 g flour, half a tsp baking soda, a pinch of salt', '150 g dark chocolate, chopped', 'flaky salt'],
  method: ['Brown the butter and let it cool.', 'Beat in the sugars and the egg.', 'Fold in the dry ingredients and the chocolate. Chill the dough for an hour.', 'Bake balls of dough at 180 degrees for 11 minutes; sprinkle with flaky salt.'],
  notes: 'Underbake slightly. Chilling the dough stops them spreading.'
}))
txt(`${REC}/shakshuka.md`, '2026-01-18', recipe({
  title: 'Shakshuka',
  serves: '2',
  prep: '10 minutes',
  cook: '25 minutes',
  ingredients: ['1 onion, 1 red pepper', '2 garlic cloves', '1 tsp cumin, 1 tsp paprika, a pinch of chilli', '1 tin crushed tomatoes', '4 eggs', 'feta and parsley'],
  method: ['Soften the onion and pepper in a wide pan.', 'Add garlic and spices, then the tomatoes; simmer for 10 minutes.', 'Make four hollows and crack in the eggs. Cover and cook until the whites are set.', 'Top with feta and parsley and serve with bread.'],
  notes: 'Sunday brunch favourite.'
}))
txt(`${REC}/pea-soup.md`, '2024-02-29', recipe({
  title: 'Yellow pea soup (Thursday soup)',
  serves: '6',
  prep: '10 minutes plus soaking overnight',
  cook: '1 hour 30 minutes',
  ingredients: ['500 g dried yellow peas', '2 litres water', '1 onion', '300 g salted pork belly', '1 tsp dried marjoram, half a tsp thyme'],
  method: ['Soak the peas in cold water overnight and rinse.', 'Bring to the boil with fresh water, skim off the foam.', 'Add the onion, pork and herbs and simmer for 1.5 hours.', 'Take out the pork, slice it and serve on the side with mustard.'],
  notes: 'Traditional on Thursdays, followed by pancakes.'
}))
txt(`${REC}/blueberry-pie.md`, '2025-08-09', recipe({
  title: 'Blueberry crumble pie',
  serves: '8',
  prep: '15 minutes',
  cook: '30 minutes',
  ingredients: ['500 g blueberries', '1 tbsp potato starch', '100 g butter, 150 g flour, 75 g sugar, 50 g oats'],
  method: ['Heat the oven to 200 degrees.', 'Toss the blueberries with the potato starch in a pie dish.', 'Rub the butter into the flour, sugar and oats and scatter over the berries.', 'Bake for 30 minutes and serve with vanilla sauce.'],
  notes: 'Picked the berries near the cabin.'
}))
txt(`${REC}/pancakes.txt`, '2024-02-29', `Swedish thin pancakes (for 4)

3 eggs, 250 ml flour, 600 ml milk, a pinch of salt, butter for the pan.
Whisk the flour with half the milk until smooth, then add the rest of the milk and the eggs.
Let the batter rest for 30 minutes.
Fry thin pancakes in butter in a hot pan, about 1 minute per side.
Serve with strawberry jam and whipped cream.
`)
txt(`${REC}/tomato-salsa.txt`, '2025-07-12', `Fresh tomato salsa

4 ripe tomatoes, half a red onion, 1 green chilli, a handful of coriander, juice of 1 lime, salt.
Chop everything small, mix, and let it stand for 15 minutes.
Good with tacos or grilled fish. Use within a day.
`)
txt(`${REC}/overnight-oats.txt`, '2025-05-05', `Overnight oats (1 jar)

50 g oats, 100 ml milk, 100 ml yoghurt, 1 tsp chia seeds, a little honey.
Stir together in a jar, close and leave in the fridge overnight.
In the morning add berries or grated apple and cinnamon.
`)

// ---------- travel ----------
const TRV = 'personal/travel'
function itinerary({ title, dates, stay, days, practical }) {
  return `${title}
Dates: ${dates}
Stay: ${stay}

${days.map((d, i) => `Day ${i + 1}: ${d}`).join('\n')}

Practical:
${practical.map((p) => `- ${p}`).join('\n')}

Before leaving home:
- Check in online 24 hours before the flight and download the boarding passes.
- Water the plants and ask the neighbour to take in the post.
- Turn the heat pump down to 16 degrees and switch off the espresso machine.
- Euro cash for the first day; cards work almost everywhere.
`
}
txt(`${TRV}/lisbon-itinerary-2026.txt`, '2026-08-25', itinerary({
  title: 'Lisbon long weekend',
  dates: '1-5 October 2026',
  stay: 'Casa Alfama guesthouse, Rua dos Remedios (booking ref LX-88213)',
  days: ['arrive 11:20, check in, evening walk up to Miradouro da Graca.', 'Belem tower, the monastery and pasteis de nata. Tram 28 back.', 'day trip to Sintra; buy train tickets from Rossio the day before.', 'LX Factory in the morning, sunset at Cais do Sodre.', 'fly home 13:45.'],
  practical: ['Get a Viva Viagem card for trams and the metro.', 'Restaurants: book dinner after 20:00.', 'Bring comfortable shoes, the hills are steep.']
}))
txt(`${TRV}/porto-itinerary-2025.txt`, '2025-08-30', itinerary({
  title: 'Porto city break',
  dates: '15-19 September 2025',
  stay: 'Ribeira apartment by the river (booking ref OP-40177)',
  days: ['arrive 16:05, metro from the airport to Trindade, dinner in Ribeira.', 'Livraria walk, Clerigos tower, port cellars in Vila Nova de Gaia.', 'Douro valley day tour with a boat trip and lunch at a quinta.', 'Foz do Douro by the old tram 1, beach walk.', 'fly home 10:30.'],
  practical: ['Andante card for metro and buses.', 'Book the Douro tour two weeks ahead.', 'Bring a light rain jacket.']
}))
distractor(`${TRV}/lisbon-itinerary-2026.txt`, `${TRV}/porto-itinerary-2025.txt`, 'same itinerary template, different city and trip')

function japan(v) {
  return `# Japan trip - itinerary ${v === 1 ? 'draft 1' : 'version 2'}
Travellers: Maya and Ida
Dates: ${v === 1 ? '4 to 14 April 2026 (10 nights)' : '6 to 17 April 2026 (11 nights)'}

## Tokyo (4 nights)
Hotel Aoba Shinjuku. Shinjuku Gyoen for the cherry blossom, teamLab, Yanaka old town, a day in Kamakura.
${v === 2 ? '\n## Hakone (1 night)\nRyokan Hanaya with a private onsen. Lake Ashi boat and the ropeway if Mount Fuji is visible.\n' : ''}
## Kyoto (${v === 1 ? '3' : '4'} nights)
Kyoto Machiya Inn Gion. Fushimi Inari early in the morning, Arashiyama bamboo grove, Philosopher's Path${v === 2 ? ', and a day trip to Nara for the deer park' : ''}.

## Osaka (2 nights)
Hotel Namba Riverside. Street food in Dotonbori, Osaka castle.

## Transport
${v === 1 ? '7-day Japan Rail Pass, ordered before departure.' : 'No rail pass: after the price increase it no longer pays off. Buy single shinkansen tickets (Tokyo-Odawara, Odawara-Kyoto, Kyoto-Osaka) and use a Suica card for local trains.'}

## Budget
${v === 1 ? 'About SEK 38,000 per person including flights.' : 'About SEK 42,000 per person including flights and the ryokan night.'}

## Food to try
Ramen in Shinjuku, conveyor belt sushi, okonomiyaki and takoyaki in Osaka, kaiseki dinner once, matcha sweets in Uji or Kyoto, and breakfast from the convenience stores, which are better than at home.

## Before we go
- Passports valid for the whole trip; no visa needed for Swedes staying under 90 days.
- Order yen from the bank one week before; many small restaurants only take cash.
- Book the teamLab tickets and the first night in Tokyo as soon as the flights are confirmed.
- Download offline maps and the train app; save hotel addresses in Japanese.
- Tell the bank about the trip so the cards are not blocked.

## Rules of thumb
No tipping. Queue on the left side of the escalator in Tokyo and on the right in Osaka. Carry rubbish home; there are few bins. Shoes off where you see a step up at the entrance.
`
}
await docxFile(`${TRV}/Japan_trip_itinerary_v1.docx`, '2026-01-20', 'Japan itinerary', japan(1))
await docxFile(`${TRV}/Japan_trip_itinerary_v2.docx`, '2026-02-15', 'Japan itinerary', japan(2))
family('Japan trip itinerary', [`${TRV}/Japan_trip_itinerary_v1.docx`, `${TRV}/Japan_trip_itinerary_v2.docx`])
txt(`${TRV}/flight-booking-ARN-NRT.txt`, '2026-02-16', `E-ticket receipt
Booking reference: K4ZT9M
Passengers: Maya Lindqvist, Ida Strand

5 Apr 2026  Stockholm Arlanda (ARN) 17:25 -> Helsinki (HEL) 19:25
5 Apr 2026  Helsinki (HEL) 23:55 -> Tokyo Narita (NRT) 19:10 +1
17 Apr 2026 Osaka Kansai (KIX) 10:30 -> Helsinki (HEL) 15:40
17 Apr 2026 Helsinki (HEL) 17:00 -> Stockholm Arlanda (ARN) 16:55

Fare: SEK 17,840 for 2 passengers, economy, 1 checked bag each (23 kg).
`)
txt(`${TRV}/japan-packing-list.md`, '2026-03-30', `# Japan packing list

- Passport, printed hotel confirmations, the e-ticket
- Suica card (load it at the airport)
- Cash in yen: many small restaurants do not take cards
- Comfortable walking shoes, slip-on shoes for temples and the ryokan
- Small towel and a bag for rubbish (few bins in the streets)
- Pocket Wi-Fi reservation, pick up at Narita
- Adapter: Japan uses type A plugs, 100 V
`)
txt(`${TRV}/copenhagen-weekend-2024.md`, '2024-10-04', `# Copenhagen weekend (11-13 October 2024)

Train from Uppsala via Stockholm, 5 h 30 min. Hotel near Norreport.
- Friday: dinner at a natural wine bar in Vesterbro.
- Saturday: Design Museum, then Torvehallerne market. Bike along the harbour to Refshaleoen.
- Sunday: Louisiana museum by train, back home on the 16:30.
`)
txt(`${TRV}/jamtland-cabin-2026.md`, '2026-06-20', `# Cabin in Jamtland, 8-21 July 2026

Cabin near Vallbo, no electricity, wood stove, water from the well.
- Food for the first four days, then shopping in Undersaker.
- Hikes: Bunnerviken (easy), Lunndorrsfjallen (long day), fishing in the river.
- Bring: headlamps, mosquito repellent, gas for the camping stove, cards and books.
- Check the forest fire risk before lighting a fire outdoors.
`)
txt(`${TRV}/norway-road-trip-2024.md`, '2024-07-01', `# Norway road trip, July 2024

Route: Uppsala - Trondheim - Atlantic Road - Alesund - Geiranger - Lillehammer - home.
Rental car pick-up at Arlanda, 12 days, unlimited kilometres.
Ferries: book the Geiranger-Hellesylt ferry online.
Camping: Alesund campsite has cabins with a sea view.
`)

// ---------- home ----------
txt('personal/home/apartment-maintenance-log.md', '2026-02-18', `# Apartment maintenance log

- 2024-01-22: new SafeNest smoke alarms in the hall and the bedroom.
- 2024-06-16: dishwasher installed (Nordvik DW-450). Water softener set to level 5.
- 2024-09-03: washing machine installed (Nordvik WM-720). Transport bolts in the storage room.
- 2025-03-10: living room painted, colour "Morning Fog".
- 2025-10-22: Ilma heat pump installed by Uppsala Klimat. First service due October 2027.
- 2025-11-08: washing machine showed F05; cleaned the drain pump filter (a sock!).
- 2026-01-14: bled the bedroom radiator, it was cold at the top.
- 2026-02-18: espresso machine descaled.
`)
txt('personal/home/balcony-garden-2026.md', '2026-04-28', `# Balcony garden 2026

South-west facing, sun from 13:00.
- Two boxes of cherry tomatoes (Sungold), sown indoors 15 March.
- Zucchini in the big pot; last year it gave far too many.
- Herbs: basil, thyme, chives, mint (mint in its own pot).
- Strawberries in the hanging basket.
- Water every evening in July; liquid feed every second week from June.
`)
txt('personal/home/bike-service-history.txt', '2025-09-20', `Velora City e-bike - service history
Bought: 2025-04-26, Cykelverkstan Uppsala, SEK 27,900
2025-05-30: first service at 310 km, brakes adjusted, free.
2025-09-20: 2,140 km. New brake pads front and rear, belt tension checked. SEK 640.
Next service: at 4,000 km or April 2026.
`)
txt('personal/home/paint-colours-living-room.txt', '2025-03-08', `Living room paint
Walls: "Morning Fog", soft grey-green, matt, 2 coats. 3 litres was enough.
Ceiling: white, matt.
Window frames: kept as they were.
Leftover paint in the storage room, labelled.
`)
txt('personal/home/wifi-and-devices.md', '2025-11-03', `# Wi-Fi and devices

- Router: Linkbay AX3000 in the hall. Admin page at 192.168.50.1.
- Main network: 2.4 and 5 GHz combined.
- Guest network (2.4 GHz only) for the robot vacuum, smart plugs and visitors.
- Raspberry Pi (192.168.1.40 on the old network, now .50.40) runs the heat pump schedule.
- Printer: on the desk, connected by cable.
`)
txt('personal/fitness/strength-routine.md', '2025-02-01', `# Strength routine (twice a week)

Warm-up: 5 minutes rowing.
1. Goblet squat 3 x 10
2. Push-ups 3 x 8-12
3. Romanian deadlift with dumbbells 3 x 10
4. One-arm row 3 x 10 per side
5. Plank 3 x 40 seconds
Increase the weight when all sets feel easy. Rest day between sessions.
`)
txt('personal/books-to-read.md', '2026-01-02', `# Books to read in 2026

- A history of Japan before the trip in April
- Something on service blueprints and operations
- Two novels a month from the library (Fernhill would be proud)
- A cookbook on Portuguese food before Lisbon
`)
txt('personal/gift-ideas.md', '2025-11-20', `# Gift ideas

- Ida: a ceramics course, or the Kyoto guidebook with the pressed-flower cover.
- Dad: new headlamp for the cabin, a fishing lure set.
- Mum: tickets to the Uppsala concert hall in spring.
- Nephew (8): a Lego set with a boat, or a kids' camera.
`)

// ---------- Downloads ----------
pdfFile(
  'Downloads/Nordic_UX_Summit_2025_programme.pdf',
  '2025-09-01',
  'Nordic UX Summit 2025 programme',
  `# Nordic UX Summit 2025 - Programme
Stockholm, 6-7 November 2025

## Day 1
09:00 Opening keynote: Designing for trust in public services
10:15 Small fixes, fewer no-shows - Maya Lindqvist
11:00 Accessibility audits that lead to change
13:30 Workshop: measuring the value of design
15:30 Panel: AI assistants in customer service

## Day 2
09:00 Service design in healthcare
10:30 Research operations for small teams
13:00 Closing keynote: The calm interface
`
)
pdfFile(
  'Downloads/whitepaper-reducing-appointment-no-shows.pdf',
  '2025-10-02',
  'Reducing appointment no-shows',
  `# Reducing Appointment No-shows: What the Research Says
A whitepaper by Remindly Research, 2025

## Summary
Missed appointments cost healthcare providers between 5% and 15% of capacity. Across 31 published studies, automated reminders reduced no-shows by a median of 29%. Two reminders (one 2-3 days before, one on the day) worked better than one.

## What works
- Reminders that include an easy way to cancel or move the appointment.
- Messages in the patient's own language.
- Sending reminders at a time the patient is likely to read them, for example 18:00.

## What does not work
- Charging a no-show fee without a reminder; it harms trust and barely changes behaviour.
- Long messages with legal text.
`
)
pdfFile(
  'Downloads/kontoret-house-rules.pdf',
  '2026-01-03',
  'Kontoret house rules',
  `# Kontoret Uppsala - House Rules

- Quiet zone on the second floor: no calls, headphones on.
- Phone booths can be used for 45 minutes at a time.
- Meeting rooms are booked in the app; members get 4 hours per month.
- Clean desk policy for flex members: nothing left overnight.
- Coffee is free; the last person out turns off the machine.
- Guests sign in at reception and are welcome for up to two days per month.
`
)
// ---------- more of the repository: modules referenced above ----------
txt(
  `${REPO}/src/auth/routes.ts`,
  '2026-02-24',
  `import type { Request, Response } from 'express'
import { pool } from '../db/client.js'
import { verifyPassword } from './password.js'
import { issueTokens, refreshAccessToken, AuthError } from './tokens.js'

/** POST /auth/login: email and password in, token pair out. Same error for unknown email and wrong password. */
export async function login(req: Request, res: Response) {
  const { email, password } = req.body ?? {}
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE email = $1 AND disabled = false', [String(email).toLowerCase()])
  if (!rows[0] || !(await verifyPassword(String(password), rows[0].password_hash))) {
    return res.status(401).json({ error: 'Wrong email or password' })
  }
  res.json(await issueTokens(rows[0].id))
}

/** POST /auth/refresh: the admin app calls this when an API call fails with "Token expired". */
export async function refresh(req: Request, res: Response) {
  try {
    res.json(await refreshAccessToken(String(req.body?.refreshToken ?? '')))
  } catch (err) {
    if (err instanceof AuthError) return res.status(401).json({ error: err.message })
    throw err
  }
}
`
)
txt(
  `${REPO}/src/payments/provider.ts`,
  '2025-10-08',
  `import { config } from '../config.js'

/** Thin client for the payment provider's REST API. Every POST carries an idempotency key when one is given. */
async function post(path: string, body: Record<string, unknown>, idempotencyKey?: string) {
  const res = await fetch('https://api.payments.example/v2' + path, {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + config.payment.apiKey,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error('Payment provider error ' + res.status)
  return res.json()
}

export const paymentApi = {
  checkout: { create: (body: Record<string, unknown>) => post('/checkout/sessions', body) },
  refunds: {
    create: ({ idempotencyKey, ...body }: { payment: string; amount: number; idempotencyKey: string }) => post('/refunds', body, idempotencyKey)
  }
}
`
)
txt(
  `${REPO}/src/notifications/reminders.ts`,
  '2026-05-12',
  `import { pool } from '../db/client.js'
import { sendTripReminderSms } from './sms.js'

/**
 * Runs every hour: finds confirmed reservations whose departure is between 47 and 48 hours away and
 * that have not had a reminder yet, sends the SMS and marks them so a rerun does not send it twice.
 */
export async function sendDueReminders() {
  const { rows } = await pool.query(
    "SELECT r.id, c.phone, t.name, d.pickup_point, g.phone AS guide_phone FROM reservations r " +
      'JOIN customers c ON c.id = r.customer_id JOIN departures d ON d.id = r.departure_id ' +
      'JOIN trips t ON t.id = d.trip_id LEFT JOIN users g ON g.id = d.guide_id ' +
      "WHERE r.status = 'confirmed' AND r.reminded_at IS NULL AND c.phone IS NOT NULL " +
      "AND d.date BETWEEN now() + interval '47 hours' AND now() + interval '48 hours'"
  )
  for (const r of rows) {
    await sendTripReminderSms(r.phone, r.name, r.pickup_point ?? 'the meeting point in your confirmation', r.guide_phone ?? '')
    await pool.query('UPDATE reservations SET reminded_at = now() WHERE id = $1', [r.id])
  }
}
`
)
txt(
  `${REPO}/tests/helpers.ts`,
  '2026-03-11',
  `import { pool } from '../src/db/client.js'

export async function seedDeparture({ capacity }: { capacity: number }): Promise<string> {
  const trip = await pool.query("INSERT INTO trips (name, region, difficulty, base_price_cents) VALUES ('Test trip', 'Jamtland', 2, 89000) RETURNING id")
  const dep = await pool.query("INSERT INTO departures (trip_id, date, capacity) VALUES ($1, CURRENT_DATE + 30, $2) RETURNING id", [trip.rows[0].id, capacity])
  return dep.rows[0].id
}

export async function seedCustomer(): Promise<string> {
  const { rows } = await pool.query("INSERT INTO customers (email, locale) VALUES ('test-' || gen_random_uuid() || '@example.com', 'sv') RETURNING id")
  return rows[0].id
}
`
)
txt(
  `${REPO}/scripts/migrate.mjs`,
  '2025-09-03',
  `// Applies SQL files in migrations/ in order and records each one in schema_migrations.
import { readdirSync, readFileSync } from 'node:fs'
import pg from 'pg'

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())')
const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))

for (const name of readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort()) {
  if (done.has(name)) continue
  const sql = readFileSync('migrations/' + name, 'utf8')
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
  const tx = !sql.includes('CONCURRENTLY')
  if (tx) await client.query('BEGIN')
  await client.query(sql)
  await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name])
  if (tx) await client.query('COMMIT')
  console.log('applied ' + name)
}
await client.end()
`
)

// ---------- more meetings and notes around the March 2026 window ----------
txt(
  `${TW}/meetings/2026-02-11 client demo.md`,
  '2026-02-11',
  `# Client demo for Acme - 11 February 2026
Present: Karin Ostlund, Noor Aziz, Jonas Berg (Acme), Maya Lindqvist

- Showed the new login for guides on the admin tablet, including staying signed in for 30 days.
- Jonas asked whether guides can see tomorrow's participants offline in the mountains. Not now; added to the backlog.
- Jonas confirmed the price list for summer 2026 and that children under 12 pay half.
- Next demo: availability calendar, end of March.
`
)
txt(
  `${TW}/meetings/2026-04-08 sprint planning.md`,
  '2026-04-08',
  `# Sprint 15 planning - 8 April 2026
Present: Karin Ostlund, Viktor Hall, Noor Aziz

Sprint goal: groups can book and pay in one checkout.
- Stories: group checkout, participant names after payment, pickup point field (behind a feature flag).
- Viktor raises the webhook alert threshold (retro action from sprint 14).
- Noor writes the load test script.
- Capacity: 26 points. Karin is out on Friday.
`
)
txt('notes/2026/2026-02-10 weekly planning.txt', '2026-02-10', weekly(7, ['Monday: CV update, add Bluebird results.', 'Tuesday: Tidewater client demo prep with Karin.', 'Wednesday: Acme proposal, think about the payment split before the call.', 'Thursday: Japan itinerary v2, check ryokan prices.', 'Friday: invoice 2026-011 for Bluebird support.']))
txt('notes/2025/2025-11-04 coworking meetup notes.md', '2025-11-04', `# Coworking meetup - 4 November 2025

Monthly breakfast at Kontoret. Topic: finding clients without cold calls.
- Most work comes from former colleagues and happy clients. Ask for an introduction at the end of every project.
- Erik posts one short case study a month; two of his clients came from that.
- Speaking at local meetups works better than paid ads for everyone in the room.
- Idea for me: a case study on Orchid's warehouse dashboards, with Hana's permission.
Next meetup: 2 December, topic "the end-of-year tax checklist".
`)

// ---------- more household files ----------
txt(`${REC}/fish-tacos.md`, '2026-07-04', recipe({
  title: 'Fish tacos',
  serves: '4',
  prep: '20 minutes',
  cook: '10 minutes',
  ingredients: ['500 g cod or pollock', '1 tsp cumin, 1 tsp paprika, salt', '12 small tortillas', 'quick pickled red onion', 'shredded white cabbage', 'lime crema: 150 ml sour cream, zest and juice of 1 lime'],
  method: ['Season the fish with the spices and fry for 3 minutes per side.', 'Warm the tortillas in a dry pan.', 'Flake the fish into the tortillas with cabbage, pickled onion and lime crema.', 'Serve with the tomato salsa.'],
  notes: 'Summer favourite on the balcony.'
}))
pdfFile(
  'Downloads/accessibility-checklist-forms.pdf',
  '2025-06-05',
  'Accessible forms checklist',
  `# Accessible Forms - a One-page Checklist

- Every field has a visible label; placeholder text is not a label.
- Errors say what went wrong and how to fix it, next to the field.
- Required fields are marked in text, not only with colour.
- The form works with the keyboard alone, in a logical order.
- Body text contrast at least 4.5:1, large text 3:1.
- Do not clear what the user typed when there is an error.
- Time limits can be extended, or are long enough for most people (for example a payment hold).
`
)
txt(
  'personal/home/storage-room-inventory.txt',
  '2025-07-06',
  `Storage room in the basement (cage 14)
- Winter tyres? No car any more, sold them.
- Transport bolts for the washing machine, in a bag on the shelf.
- Leftover living room paint, Morning Fog.
- Camping gear: tent, two sleeping mats, gas stove.
- Christmas decorations, two boxes.
Larger furniture moved to the rented unit in July 2025.
`
)
txt(
  'clients/harbor-pine-hotels/email-copy-german-v1.md',
  '2025-07-15',
  `# Pre-arrival email copy - German (first version)

Subject: In 7 Tagen in Visby - wir freuen uns auf Sie!

Hallo {first_name},
in einer Woche beginnt Ihr Aufenthalt im Harbor & Pine Visby. Check-in ist ab 15 Uhr, die Rezeption ist rund um die Uhr besetzt.
Parken: Wir haben 14 Parkplatze direkt am Hotel, ohne Reservierung.
Frueh zur Faehre? Bestellen Sie unsere Fruehstuecksbox fur SEK 145.
Bis bald!

Notes: Lucia wants "Sie", not "du". Check umlauts before sending; this draft is typed without them.
`
)
// =====================================================================================================
// OCR fixtures (Stage 4 S4-06): images and image-only PDFs whose words appear nowhere else in the corpus
// =====================================================================================================
const ocrFiles = []
if (canvasLib) {
  const img = (rel, date, spec) => {
    const { buf } = renderImage(spec)
    add(rel, date, buf, null)
    ocrFiles.push(rel)
  }
  const mono = 'Courier New'

  img('finance/receipts/IMG_2041.jpg', '2025-04-12', {
    width: 760,
    font: mono,
    size: 30,
    bg: '#f4f1e8',
    format: 'jpeg',
    lines: [
      { text: 'BERGSTROM JARNHANDEL', bold: true, align: 'center', size: 36 },
      { text: 'Dragarbrunnsgatan 31, Uppsala', align: 'center', size: 26 },
      { text: 'Org.nr 556120-4478', align: 'center', size: 26 },
      '',
      '2025-04-12  14:37   Kassa 2',
      '--------------------------------',
      row('Cordless drill Torvik 18V', '1295.00'),
      row('Drill bit set, 15 pcs', '149.00'),
      row('Wall plugs 8mm x50', '59.00'),
      row('Spirit level 60 cm', '189.00'),
      row('Masking tape', '39.00'),
      '--------------------------------',
      { text: row('TOTAL SEK', '1731.00'), bold: true },
      row('of which VAT 25%', '346.20'),
      row('Card payment', '1731.00'),
      '',
      { text: 'Open purchase: 30 days', align: 'center' },
      { text: 'Thank you for your visit!', align: 'center' }
    ]
  })

  img('finance/receipts/receipt-cafe-2026-03-12.png', '2026-03-12', {
    width: 700,
    font: mono,
    size: 30,
    bg: '#fbfbf7',
    lines: [
      { text: 'KAFE SOLROSEN', bold: true, align: 'center', size: 38 },
      { text: 'Sysslomansgatan 4, Uppsala', align: 'center', size: 26 },
      '',
      '2026-03-12 10:14  Table 6',
      '------------------------------',
      row('Oat flat white', '52.00', 30),
      row('Filter coffee', '34.00', 30),
      row('Cheese sandwich, rye', '79.00', 30),
      row('Almond croissant', '45.00', 30),
      '------------------------------',
      { text: row('Total SEK', '210.00', 30), bold: true },
      row('VAT 12%', '22.50', 30),
      'Paid by card ****4471',
      '',
      { text: 'Free wifi: solrosen-guest', align: 'center', size: 26 }
    ]
  })

  img('scans/whiteboard-2026-04-14.png', '2026-04-14', {
    width: 1280,
    font: 'Arial',
    size: 40,
    bg: '#fdfdfb',
    fg: '#17306b',
    lines: [
      { text: 'SPRINT 15 GOALS', bold: true, size: 56 },
      '',
      '1. Group checkout: lead contact pays, names later',
      '2. Pickup points at checkout (3 stops for Acme)',
      '3. Retire the old TripDesk importer by 30 April',
      '4. Load test with 60 parallel checkouts',
      '',
      'Owner: Karin     Demo: Friday 24 April',
      { text: 'Blocked: GPS list from Elsa still missing!', bold: true }
    ]
  })

  img('scans/landlord-letter-2025-10.png', '2025-10-06', {
    width: 1240,
    font: 'Times New Roman',
    size: 32,
    bg: '#f6f4ee',
    lines: [
      { text: 'Fastighets AB Kvarnstenen', bold: true, size: 40 },
      'Box 1182, 751 41 Uppsala',
      '',
      'To the tenants of Svartbacksgatan 8',
      'Uppsala, 6 October 2025',
      '',
      { text: 'Notice: replacement of water and drain pipes', bold: true },
      '',
      'The water and drain pipes in your building will be',
      'replaced between 9 February and 20 March 2026.',
      'Your bathroom cannot be used for about three weeks',
      'during this period. A temporary shower and toilet',
      'will be available in the laundry room in the basement.',
      'The rent will be reduced by 30% for the affected weeks.',
      '',
      'Questions: property manager Goran Nyberg, 018-55 02 77',
      '',
      'Kind regards, Fastighets AB Kvarnstenen'
    ]
  })

  img('scans/parking-permit-2026.jpg', '2026-01-08', {
    width: 1000,
    font: 'Arial',
    size: 34,
    bg: '#eef3f7',
    format: 'jpeg',
    lines: [
      { text: 'UPPSALA MUNICIPALITY', bold: true, align: 'center', size: 40 },
      { text: 'Residential parking permit', align: 'center', size: 38 },
      '',
      'Zone: K (Svartbacken)',
      'Vehicle registration: KLM 482',
      'Holder: Maya Lindqvist',
      'Valid: 1 January 2026 - 31 December 2026',
      'Fee: SEK 795 per month',
      '',
      { text: 'Display clearly behind the windscreen', align: 'center', size: 30 }
    ]
  })

  img('Downloads/Screenshot 2026-05-03 webhook settings.png', '2026-05-03', {
    width: 1400,
    font: 'Arial',
    size: 30,
    bg: '#ffffff',
    fg: '#20232a',
    lines: [
      { text: 'Developers  >  Webhook endpoints', size: 26 },
      { text: 'book.tidewaterlabs.se/webhooks/payments', bold: true, size: 36 },
      '',
      'Status: Enabled          API version: 2025-09',
      'Listening to: payment.succeeded, payment.failed, refund.completed',
      'Signing secret: whsec_****8f2a   (rolled 3 May, overlap 24 hours)',
      '',
      'Delivery success, last 7 days: 99.2%',
      'Failed deliveries: 14   Average response time: 186 ms',
      'Last failure: 401 Unauthorized, retried automatically'
    ]
  })

  const scanPage = (spec) => {
    const r = renderImage({ ...spec, format: 'jpeg' })
    return { jpeg: r.buf, width: r.width, height: r.height }
  }
  add(
    'scans/Solvik_AP-30_warranty_card_scan.pdf',
    '2025-12-01',
    pdfFromImages(
      [
        scanPage({
          width: 1100,
          font: 'Arial',
          size: 34,
          bg: '#f2efe6',
          lines: [
            { text: 'SOLVIK', bold: true, size: 52 },
            { text: 'AP-30 Air Purifier - Warranty Card', bold: true, size: 38 },
            '',
            'Serial number: AP30-7741-K',
            'Date of purchase: 28 November 2025',
            'Retailer: Elkedja, Uppsala',
            '',
            'Warranty: 3 years from the date of purchase.',
            'The HEPA filter is a wear part and is not covered.',
            'Replace the HEPA filter every 12 months.',
            '',
            'Register online within 30 days for 1 extra year.'
          ]
        })
      ],
      'Scan 2025-12-01'
    ),
    null
  )
  ocrFiles.push('scans/Solvik_AP-30_warranty_card_scan.pdf')

  add(
    'scans/storage-unit-agreement-scan.pdf',
    '2025-06-30',
    pdfFromImages(
      [
        scanPage({
          width: 1240,
          font: 'Times New Roman',
          size: 32,
          bg: '#f7f6f1',
          lines: [
            { text: 'FORRADET SELF STORAGE', bold: true, size: 42 },
            { text: 'Rental agreement for a storage unit', size: 36 },
            '',
            'Tenant: Maya Lindqvist',
            'Unit: B-114, ground floor, 6 square metres',
            'Start date: 1 July 2025, no fixed end date',
            'Rent: SEK 890 per month, paid quarterly',
            'Notice period: one calendar month',
            'Gate access code: 2580, open 06:00 - 22:00',
            '',
            'No flammable liquids, food or valuables in the unit.',
            '',
            'Signed: Maya Lindqvist           Date: 30 June 2025'
          ]
        }),
        scanPage({
          width: 1240,
          font: 'Times New Roman',
          size: 32,
          bg: '#f7f6f1',
          lines: [
            { text: 'General terms (page 2)', bold: true, size: 36 },
            '',
            'The landlord may enter the unit after 7 days notice',
            'for inspection or repairs.',
            'Insurance of stored goods is the tenant\'s responsibility.',
            'Unpaid rent for 60 days gives the right to end the lease.'
          ]
        })
      ],
      'Scan 2025-06-30'
    ),
    null
  )
  ocrFiles.push('scans/storage-unit-agreement-scan.pdf')
}

// =====================================================================================================
// README (written by the generator so a regeneration keeps it; old mtime so it never ranks as "latest")
// =====================================================================================================
txt(
  'README.md',
  '2024-01-01',
  `# Stage 4 eval corpus

Synthetic files for the Stage 4 retrieval evaluation. Everything here is invented: people, companies, numbers, addresses and bank details.

Contents: the files of a freelance consultant with several clients (proposals and contracts in several versions, call notes, invoices), a small software team (policies, retros, meeting notes and a booking and payments code repository), and a household (manuals, receipts, recipes, travel plans). Also exact duplicate copies, look-alike files built from the same template, and images and scanned PDFs with text only readable by OCR.

Regenerate with: node scripts/make-eval-corpus.mjs

File dates matter for the time-based queries. Git does not keep them, so they are stored in ../eval-corpus.manifest.json and must be applied after copying the folder. The queries are in tests/eval/queries-s4.jsonl. This README is not part of any query.
`
)

// =====================================================================================================
// Write files, manifest and a validation summary
// =====================================================================================================
rmSync(ROOT, { recursive: true, force: true })
const manifestFiles = {}
for (const [rel, f] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const abs = path.join(ROOT, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, f.data)
  const t = toDate(f.date)
  utimesSync(abs, t, t)
  manifestFiles[rel] = t.toISOString()
}

const shingles = (text, k = 3) => {
  const w = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const s = new Set()
  for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' '))
  return s
}
const jaccard = (a, b) => {
  const A = shingles(files.get(a).text)
  const B = shingles(files.get(b).text)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return Number((inter / (A.size + B.size - inter)).toFixed(2))
}

const problems = []
const familyReport = families.map(({ name, members }) => {
  for (const m of members) if (!files.has(m)) problems.push(`family ${name}: missing ${m}`)
  const times = members.map((m) => toDate(files.get(m).date).getTime())
  if (times.some((t, i) => i > 0 && t <= times[i - 1])) problems.push(`family ${name}: mtimes not increasing`)
  const similarity = members.slice(1).map((m, i) => jaccard(members[i], m))
  return { name, members, newest: members.at(-1), similarity }
})
for (const set of duplicates) {
  const first = files.get(set[0]).data
  for (const rel of set.slice(1)) if (!files.get(rel).data.equals(first)) problems.push(`duplicate ${rel} differs from ${set[0]}`)
}
const distractorReport = distractors.map((d) => ({ ...d, similarity: jaccard(d.a, d.b) }))
for (const [rel, f] of files) {
  const ext = path.extname(rel).slice(1)
  if (f.data.length > 8 * 1024 && !['pdf', 'png', 'jpg', 'docx'].includes(ext)) problems.push(`large text file ${rel} (${f.data.length} bytes)`)
}

writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      files: manifestFiles,
      // Version families, oldest first. Byte-identical copies of a member are not repeated here; they are in "duplicates".
      families: familyReport.map(({ name, members }) => ({ name: slug(name), members })),
      duplicates,
      distractorPairs: distractors.map(({ a, b }) => [a, b]),
      ocr: ocrFiles
    },
    null,
    2
  ) + '\n'
)

const byExt = {}
for (const rel of files.keys()) {
  const ext = path.extname(rel).slice(1).toLowerCase()
  byExt[ext] = (byExt[ext] ?? 0) + 1
}
console.log(`Wrote ${files.size} files to ${ROOT}`)
console.log('By extension:', JSON.stringify(byExt))
for (const f of familyReport) console.log(`Family ${f.name}: ${f.members.length} versions, adjacent 3-shingle Jaccard ${f.similarity.join(', ')}`)
for (const d of distractorReport) console.log(`Distractor ${d.a} <> ${d.b}: Jaccard ${d.similarity}`)
console.log(`Duplicate sets: ${duplicates.length}; OCR files: ${ocrFiles.length}`)
if (problems.length) {
  console.error('Problems:\n' + problems.join('\n'))
  process.exitCode = 1
}
