import { pool } from '../db/client.js'

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
