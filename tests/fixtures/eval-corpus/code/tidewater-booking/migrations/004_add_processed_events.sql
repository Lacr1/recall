-- Webhook idempotency: one row per payment provider event we have handled.
CREATE TABLE processed_events (
  event_id text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Keep 90 days of event ids; the provider never retries older events.
CREATE INDEX processed_events_processed_at ON processed_events (processed_at);
