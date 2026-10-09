CREATE TABLE waitlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL REFERENCES departures(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  seats smallint NOT NULL,
  position serial,
  status text NOT NULL DEFAULT 'waiting',
  offer_expires_at timestamptz
);
