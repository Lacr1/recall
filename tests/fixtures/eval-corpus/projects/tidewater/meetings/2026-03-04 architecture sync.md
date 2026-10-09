# Architecture sync - 4 March 2026
Present: Karin Ostlund (tech lead), Viktor Hall, Noor Aziz, Maya Lindqvist (for Acme)

## Seat holds
Maya explained the Acme problem: two customers can pay for the last seat at the same time. Decision: a reservation row with status "held" is inserted inside a transaction that locks the trip row (SELECT ... FOR UPDATE). Holds expire after 10 minutes and a job releases them every minute.

## Group bookings
Groups up to 12 people are one reservation with a seat count, not 12 reservations. Pricing gives 10% off from 6 people and 15% from 10.

## Webhooks
We will store every processed payment event id so a retried webhook is ignored (idempotency). See ADR 0002.

## Decisions
- Postgres stays the only database; no Redis for locks.
- Karin writes migration 005 for the waitlist table.
