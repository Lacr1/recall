import cron from 'node-cron'
import { releaseExpiredHolds } from '../booking/reservations.js'
import { sendDueReminders } from '../notifications/reminders.js'
import { log } from '../lib/logger.js'

/** Background jobs. Times are Europe/Stockholm. */
export function startJobs() {
  // Every minute: free seats from checkouts that were abandoned.
  cron.schedule('* * * * *', async () => {
    const n = await releaseExpiredHolds()
    if (n) log.info('released ' + n + ' expired holds')
  })
  // Every hour at :05: SMS reminders for trips that leave in 48 hours.
  cron.schedule('5 * * * *', sendDueReminders, { timezone: 'Europe/Stockholm' })
}
