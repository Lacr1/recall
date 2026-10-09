import { pool } from '../db/client.js'
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
