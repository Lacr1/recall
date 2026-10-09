-- The availability query filtered reservations by departure and status with a sequential scan
-- (about 900 ms on production data). This index brings it down to about 40 ms.
CREATE INDEX CONCURRENTLY reservations_departure_status ON reservations (departure_id, status);
