import { pool } from '../db/client.js'
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
