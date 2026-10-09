# Changelog

## 1.8.0 - 2026-05-02
- Waitlist: the next person is offered a freed seat automatically and has 2 hours to accept.
- Cancellations follow the published policy (full refund more than 7 days before departure).

## 1.7.0 - 2026-03-26
- Index on reservations (trip_id, status) makes the availability query about 20 times faster.
- Seat holds of 10 minutes stop two customers from booking the last seat.

## 1.6.0 - 2026-02-24
- Refresh tokens rotate on every use; reusing an old refresh token revokes the whole session family.

## 1.5.2 - 2025-11-20
- Payment webhooks: alert on repeated signature failures after the November outage.

## 1.5.0 - 2025-10-08
- Checkout sessions with the payment provider; amounts stored in cents.
