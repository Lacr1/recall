# Incident review - payment webhooks down (18 November 2025)
Present: Karin Ostlund, Viktor Hall, Noor Aziz

## What happened
From 14:05 to 17:45 on 18 November 2025 (3 hours 40 minutes), every payment webhook was rejected with HTTP 401. The payment provider had rotated our webhook signing secret after we clicked "roll secret" during a dashboard clean-up, and the new secret was never put in the production config.

## Impact
212 bookings stayed in "pending payment" although customers had paid. 37 customers emailed support. No money was lost.

## Fix
The new secret was deployed at 17:40 and the provider resent all failed events; the idempotency table made sure none was processed twice.

## Follow-up
- Alert when more than 5 webhooks in 10 minutes fail signature checks.
- Store the signing secret in the secrets manager, not in config files.
- Write a runbook for rotating the secret with a 24 hour overlap.
