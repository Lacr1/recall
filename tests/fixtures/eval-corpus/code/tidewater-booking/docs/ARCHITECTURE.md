# Architecture

One Node service (Express) in front of one Postgres database. No message queue: background work runs as cron jobs inside the service, and every job is safe to run twice.

## Booking flow
1. The customer picks a departure; the calendar calls GET /trips/:id/availability.
2. POST /trips/:id/holds places a 10 minute hold (row lock on the departure, see src/booking/reservations.ts).
3. The customer pays on the provider's hosted checkout page.
4. The provider calls our webhook; we verify the signature, record the event id and confirm the reservation.
5. A confirmation email goes out in the customer's language.

## Why no Redis
Postgres row locks are enough for our volume (peak 30 checkouts per minute in June) and one less system to run.

## Authentication
Short-lived JWT access tokens (15 minutes) and rotating refresh tokens (30 days). See ADR 0003.
