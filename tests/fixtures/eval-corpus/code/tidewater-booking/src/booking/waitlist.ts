import { pool } from '../db/client.js'
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
