import { pool, withTransaction } from '../db/client.js'
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
