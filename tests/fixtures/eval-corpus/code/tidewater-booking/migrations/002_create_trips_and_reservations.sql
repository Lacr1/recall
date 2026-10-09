CREATE TABLE trips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  region text NOT NULL,
  difficulty smallint NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  base_price_cents integer NOT NULL
);

CREATE TABLE departures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id uuid NOT NULL REFERENCES trips(id),
  date date NOT NULL,
  capacity smallint NOT NULL,
  guide_id uuid REFERENCES users(id)
);

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_id uuid NOT NULL REFERENCES departures(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  seats smallint NOT NULL CHECK (seats BETWEEN 1 AND 12),
  status text NOT NULL,
  price_cents integer NOT NULL,
  payment_id text,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);
