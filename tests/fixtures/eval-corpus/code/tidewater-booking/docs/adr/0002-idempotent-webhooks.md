# ADR 0002: Idempotent payment webhooks

Status: accepted, November 2025, after the webhook outage on 18 November

## Context
The payment provider retries a webhook until it gets a 2xx response, for up to three days. After the outage it resent hundreds of events at once. Handling an event twice would send two confirmation emails or refund a customer twice.

## Decision
Every event id is inserted into processed_events before the event is handled. If the insert conflicts, we answer 200 and do nothing. Refund calls to the provider also carry an idempotency key.

## Consequences
The table grows by about 2,000 rows a month; rows older than 90 days are deleted.
