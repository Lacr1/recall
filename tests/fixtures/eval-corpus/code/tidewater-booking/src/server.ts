import express from 'express'
import { config } from './config.js'
import { requireAuth, requireRole } from './auth/middleware.js'
import { login, refresh } from './auth/routes.js'
import { getAvailability } from './booking/availability.js'
import { holdSeats, confirmReservation } from './booking/reservations.js'
import { joinWaitlist } from './booking/waitlist.js'
import { createCheckoutSession } from './payments/checkout.js'
import { handlePaymentWebhook } from './payments/webhooks.js'
import { rateLimit } from './lib/rateLimit.js'
import { startJobs } from './jobs/scheduler.js'

const app = express()

// The webhook needs the raw body to verify the signature, so it is mounted before express.json().
app.post('/webhooks/payments', express.raw({ type: 'application/json' }), handlePaymentWebhook)
app.use(express.json())

app.post('/auth/login', rateLimit({ perMinute: 5 }), login)
app.post('/auth/refresh', rateLimit({ perMinute: 30 }), refresh)

app.get('/trips/:tripId/availability', rateLimit({ perMinute: 60 }), async (req, res) => {
  res.json(await getAvailability(req.params.tripId, String(req.query.date)))
})
app.post('/trips/:tripId/holds', requireAuth, async (req, res) => {
  res.status(201).json(await holdSeats(req.params.tripId, req.user.id, Number(req.body.seats)))
})
app.post('/reservations/:id/checkout', requireAuth, async (req, res) => {
  res.json(await createCheckoutSession(req.params.id))
})
app.post('/reservations/:id/confirm', requireAuth, requireRole('admin'), async (req, res) => {
  res.json(await confirmReservation(req.params.id))
})
app.post('/trips/:tripId/waitlist', requireAuth, async (req, res) => {
  res.status(201).json(await joinWaitlist(req.params.tripId, req.user.id, Number(req.body.seats)))
})

app.listen(config.port, () => {
  startJobs()
  console.log('tidewater-booking listening on ' + config.port)
})
