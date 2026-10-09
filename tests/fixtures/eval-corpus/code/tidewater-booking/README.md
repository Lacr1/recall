# tidewater-booking

Booking and payments service for guided trip operators (first customer: Acme Outdoor). Node 20, TypeScript, Express and Postgres.

## Running locally
1. Copy config/staging.yaml to config/local.yaml and point it at your database.
2. docker compose up -d db
3. npm install
4. npm run migrate
5. npm run dev  (listens on port 4010)

## Modules
- src/auth: access and refresh tokens, password hashing, the requireAuth middleware
- src/booking: availability, seat holds, reservations, pricing, waitlist, cancellations
- src/payments: checkout sessions, payment webhooks, refunds
- src/notifications: confirmation emails and SMS reminders
- src/jobs: scheduled jobs (release expired holds, send reminders)

## Deploying
scripts/deploy.sh staging|production. Production deploys need an approved pull request and a green test run.

## Testing
npm test runs unit and integration tests against a throwaway database.
