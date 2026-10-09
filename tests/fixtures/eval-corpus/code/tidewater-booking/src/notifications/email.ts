import nodemailer from 'nodemailer'
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
