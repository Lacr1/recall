-- Most booked trips in the last 12 months, with average group size.
SELECT t.name,
       t.region,
       COUNT(*) AS bookings,
       SUM(r.seats) AS people,
       ROUND(AVG(r.seats), 1) AS avg_group_size
FROM reservations r
JOIN departures d ON d.id = r.departure_id
JOIN trips t ON t.id = d.trip_id
WHERE r.status = 'confirmed'
  AND d.date >= CURRENT_DATE - INTERVAL '12 months'
GROUP BY t.name, t.region
ORDER BY people DESC
LIMIT 20;
