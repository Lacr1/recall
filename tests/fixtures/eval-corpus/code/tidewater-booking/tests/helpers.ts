import { pool } from '../src/db/client.js'

export async function seedDeparture({ capacity }: { capacity: number }): Promise<string> {
  const trip = await pool.query("INSERT INTO trips (name, region, difficulty, base_price_cents) VALUES ('Test trip', 'Jamtland', 2, 89000) RETURNING id")
  const dep = await pool.query("INSERT INTO departures (trip_id, date, capacity) VALUES ($1, CURRENT_DATE + 30, $2) RETURNING id", [trip.rows[0].id, capacity])
  return dep.rows[0].id
}

export async function seedCustomer(): Promise<string> {
  const { rows } = await pool.query("INSERT INTO customers (email, locale) VALUES ('test-' || gen_random_uuid() || '@example.com', 'sv') RETURNING id")
  return rows[0].id
}
