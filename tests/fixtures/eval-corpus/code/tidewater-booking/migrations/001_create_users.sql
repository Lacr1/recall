-- Users of the admin view (staff and guides) and customers who book trips.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'guide')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  phone text,
  locale text NOT NULL DEFAULT 'sv'
);

CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  family_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked boolean NOT NULL DEFAULT false
);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
