// Generates the synthetic corpus in tests/fixtures/corpus (safe to commit: all content is invented).
// Usage: node scripts/make-fixtures.mjs
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const JSZip = require('jszip') // installed as a dependency of mammoth

const ROOT = path.resolve('tests/fixtures/corpus')
rmSync(ROOT, { recursive: true, force: true })

const files = []
const add = (rel, data, date) => files.push({ rel, data, date })

// ---------- minimal PDF writer (Helvetica, ASCII text) ----------
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

function pdf(pages, title) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const objs = []
  const pageIds = []
  const fontId = 3
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[fontId] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  let next = 4
  for (const pageText of pages) {
    const lines = pageText === null ? [] : wrap(pageText)
    let stream
    if (pageText === null) {
      // A page with only a drawn rectangle: no text layer, like a scan.
      stream = '0.8 g 72 300 450 400 re f'
    } else {
      stream = 'BT /F1 11 Tf 14 TL 72 760 Td\n' + lines.map((l) => `(${esc(l)}) Tj T*`).join('\n') + '\nET'
    }
    const contentId = next++
    const pageId = next++
    objs[contentId] = `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`
    objs[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    pageIds.push(pageId)
  }
  objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const infoId = next++
  objs[infoId] = `<< /Title (${esc(title)}) /Producer (Recall fixtures) >>`
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

// ---------- minimal DOCX writer ----------
async function docx(blocks, title) {
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = blocks
    .map(([kind, text]) =>
      kind === 'p'
        ? `<w:p><w:r><w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p>`
        : `<w:p><w:pPr><w:pStyle w:val="Heading${kind[1]}"/></w:pPr><w:r><w:t>${x(text)}</w:t></w:r></w:p>`
    )
    .join('')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
  )
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  )
  zip.file(
    'word/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      [1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/></w:style>`).join('') +
      '</w:styles>'
  )
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${x(title)}</dc:title></cp:coreProperties>`
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`
  )
  return zip.generateAsync({ type: 'nodebuffer' })
}

// ---------- content ----------
const proposalIntro = (v) =>
  `Prepared for Acme Outdoor Co. by Maya Lindqvist Consulting. Version ${v}. This proposal covers the redesign of the Acme online booking system for guided hiking trips, including availability search, group bookings and confirmation emails.`

const acmeV1 = await docx(
  [
    ['h1', 'Acme Booking System Redesign - Proposal'],
    ['p', proposalIntro(1)],
    ['h2', 'Scope'],
    ['p', 'Discovery workshops, a new availability calendar, a simplified checkout and an admin view for trip leaders.'],
    ['h2', 'Fees'],
    ['p', 'The total fee is EUR 24,000, invoiced monthly in arrears over the three month engagement.'],
    ['h2', 'Timeline'],
    ['p', 'Work starts in February and finishes at the end of April.']
  ],
  'Acme Booking Proposal v1'
)
add('clients/acme/Acme_Proposal_v1.docx', acmeV1, '2026-01-12')

add(
  'clients/acme/Acme_Proposal_v2.pdf',
  pdf(
    [
      `Acme Booking System Redesign - Proposal (v2)\n\n${proposalIntro(2)}\n\nScope\nDiscovery workshops, a new availability calendar, a simplified checkout, an admin view for trip leaders and a waitlist for sold-out trips.`,
      `Payment terms\nWe propose a 50% initial payment upon signing, with the remaining balance due on completion of the project. The total fee is EUR 26,000.\n\nTimeline\nWork starts in March and finishes at the end of May.\n\nWarranty\nWe fix defects reported within 60 days of launch at no extra cost.`
    ],
    'Acme Booking Proposal v2'
  ),
  '2026-02-03'
)

add(
  'clients/acme/Acme_Proposal_v3.docx',
  await docx(
    [
      ['h1', 'Acme Booking System Redesign - Proposal'],
      ['p', proposalIntro(3)],
      ['h2', 'Payment terms'],
      [
        'p',
        'After our call we changed the structure: 40% upfront on signing, then two payment milestones of 30% each, the first when the new availability calendar goes live and the second at final handover. The total fee is EUR 26,000.'
      ],
      ['h2', 'Timeline'],
      ['p', 'Work starts on 9 March. Milestone one: calendar live by 17 April. Milestone two: handover by 29 May.'],
      ['h2', 'Warranty'],
      ['p', 'Defects reported within 90 days of launch are fixed at no extra cost.']
    ],
    'Acme Booking Proposal v3'
  ),
  '2026-02-20'
)

add(
  'clients/acme/call-notes-acme.md',
  `# Call notes - Acme Outdoor (18 Feb 2026)

Attendees: Maya, Jonas (Acme ops), Priya (Acme finance)

## Payment
Priya said a 50% deposit is too much for their cash flow this quarter. We agreed to move to 40% upfront and split the rest into two milestones. I will send a revised proposal (v3).

## Booking system
Jonas wants group bookings for up to 12 people and a waitlist when trips sell out. The current system double-books guides when two people check out at the same time.

## Decisions
- Payment structure changes to 40 / 30 / 30.
- Waitlist is in scope; gift cards are out of scope.
`,
  '2026-02-18'
)

add(
  'Downloads/Acme_Proposal_v3 (1).docx',
  null, // filled below with identical bytes (exact duplicate)
  '2026-02-21'
)

add(
  'clients/bluebird/Bluebird_Statement_of_Work.pdf',
  pdf(
    [
      `Statement of Work - Bluebird Dental Clinics\n\nThis statement of work covers a patient reminder service that sends SMS and email reminders 48 hours before appointments.\n\nDeliverables\nReminder scheduler, message templates in English and Swedish, an opt-out page, and a monthly report of no-show rates.\n\nCommercial terms\nFixed price of EUR 9,500 payable in two equal instalments: half on kickoff and half on acceptance. Support is billed at EUR 95 per hour.`
    ],
    'Bluebird SOW'
  ),
  '2025-11-04'
)

add(
  'clients/bluebird/invoice-2025-118.txt',
  `INVOICE 2025-118
Maya Lindqvist Consulting
Bill to: Bluebird Dental Clinics
Date: 2025-11-10

Description: Patient reminder service - kickoff instalment (50%)
Amount: EUR 4,750.00
Payment due within 30 days. Bank transfer to SE45 5000 0000 0583 9825 7466.
`,
  '2025-11-10'
)

add(
  'notes/2026-03-02 booking system retro.md',
  `# Retro: booking system improvements

## What went well
- The new availability calendar loads in under a second.
- Trip leaders like the admin view.

## What to improve
- Double bookings still happen when two customers pay at the same moment; we need a reservation lock that expires after 10 minutes.
- Confirmation emails go to spam for Outlook users. Set up SPF and DKIM for the booking domain.
- The waitlist should notify people automatically when a spot opens.

## Ideas
Show remaining spots on each trip card and let customers pick a pickup point.
`,
  '2026-03-02'
)

add(
  'notes/weekly-planning.txt',
  `Weekly planning - week 11
Monday: finish Acme calendar endpoint, review Bluebird report numbers.
Tuesday: dentist 14:00. Call accountant about VAT return.
Wednesday: write blog post about pricing small consulting projects.
Thursday: Acme milestone demo prep.
Friday: invoices, inbox zero, plan next week.
`,
  '2026-03-09'
)

add(
  'code/booking-app/README.md',
  `# booking-app

Node service for Acme trip bookings.

## Running locally
npm install, then npm run dev. Needs a Postgres database (see .env.example).

## Modules
- src/auth: login sessions and token refresh
- src/booking: availability and reservations
`,
  '2026-03-05'
)

add(
  'code/booking-app/src/auth/session.ts',
  `import { randomBytes, timingSafeEqual } from 'node:crypto'
import { db } from '../db'

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14

// Creates a login session after the password has been verified.
export async function createSession(userId: string) {
  const token = randomBytes(32).toString('hex')
  await db.sessions.insert({ userId, token, expiresAt: Date.now() + SESSION_TTL_MS })
  return token
}

// Validates the session cookie on each request and slides the expiry window.
export async function authenticate(token: string) {
  const session = await db.sessions.findByToken(token)
  if (!session || session.expiresAt < Date.now()) return null
  if (!timingSafeEqual(Buffer.from(session.token), Buffer.from(token))) return null
  await db.sessions.update(session.id, { expiresAt: Date.now() + SESSION_TTL_MS })
  return session.userId
}

export async function logout(token: string) {
  await db.sessions.deleteByToken(token)
}
`,
  '2026-03-04'
)

add(
  'code/booking-app/src/booking/availability.ts',
  `import { db } from '../db'

const HOLD_MINUTES = 10

// Returns open spots for a trip, excluding seats held by unfinished checkouts.
export async function spotsLeft(tripId: string) {
  const trip = await db.trips.get(tripId)
  const confirmed = await db.reservations.count({ tripId, status: 'confirmed' })
  const held = await db.reservations.count({ tripId, status: 'held', newerThanMinutes: HOLD_MINUTES })
  return Math.max(0, trip.capacity - confirmed - held)
}

// Places a temporary hold so two customers cannot book the last seat at once.
export async function holdSeat(tripId: string, customerId: string) {
  if ((await spotsLeft(tripId)) <= 0) throw new Error('Trip is full')
  return db.reservations.insert({ tripId, customerId, status: 'held' })
}
`,
  '2026-03-06'
)

add(
  'manuals/Dishwasher_DW-450_Manual.pdf',
  pdf(
    [
      `Nordvik DW-450 Dishwasher - User Manual\n\nInstallation\nConnect the inlet hose to a cold water tap. Make sure the drain hose is not kinked.\n\nEveryday use\nLoad plates facing the centre. Use the Eco programme for normally soiled dishes.`,
      `Warranty\nThe warranty period is 24 months from the date of purchase and covers manufacturing defects. Keep your receipt. The warranty does not cover damage from limescale; descale every three months in hard water areas.\n\nError codes\nE1 - water inlet problem. E4 - leak detected; turn off the water supply and contact service.`
    ],
    'DW-450 Manual'
  ),
  '2024-06-15'
)

add(
  'manuals/laptop-purchase.txt',
  `Order confirmation - ThinkBook 14 laptop
Order date: 2025-08-22
Price: EUR 1,149
Extended warranty: 3 years on-site service (purchased separately, ends 2028-08-22).
Return window: 30 days.
`,
  '2025-08-22'
)

add(
  'personal/recipes/lasagna.md',
  `# Lasagna for six

Brown 500 g minced beef with onion and garlic. Add crushed tomatoes and simmer for 40 minutes.
Make a bechamel with butter, flour and milk. Layer pasta sheets, sauce and bechamel; finish with parmesan.
Bake at 190 degrees for 45 minutes. Rest for 15 minutes before serving.
`,
  '2025-12-01'
)

add(
  'personal/travel/lisbon-itinerary.txt',
  `Lisbon trip, 3-7 May
Day 1: arrive 11:20, check in near Alfama. Evening walk to Miradouro da Graca.
Day 2: Belem tower and pasteis de nata. Tram 28 back.
Day 3: day trip to Sintra, book train tickets in advance.
Day 4: LX Factory, sunset at Cais do Sodre.
`,
  '2026-04-01'
)

add('archive/scanned-receipt.pdf', pdf([null], 'Scanned receipt'), '2025-03-03')
add('archive/broken.pdf', Buffer.from('%PDF-1.4\nthis file was truncated during download'), '2025-03-04')

// ---------- write ----------
const v3 = files.find((f) => f.rel === 'clients/acme/Acme_Proposal_v3.docx').data
files.find((f) => f.data === null).data = v3
for (const f of files) {
  const abs = path.join(ROOT, f.rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, f.data)
  const t = new Date(f.date + 'T10:00:00Z')
  utimesSync(abs, t, t)
}
console.log(`Wrote ${files.length} files to ${ROOT}`)
