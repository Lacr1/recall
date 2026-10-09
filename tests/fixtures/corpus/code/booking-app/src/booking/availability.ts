import { db } from '../db'

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
