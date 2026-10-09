import { pool } from '../db/client.js'
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
