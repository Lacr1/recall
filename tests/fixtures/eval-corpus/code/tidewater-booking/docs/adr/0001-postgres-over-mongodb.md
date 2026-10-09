# ADR 0001: Postgres instead of MongoDB

Status: accepted, September 2025

## Context
Bookings, payments and refunds must stay consistent. A seat must never be sold twice.

## Decision
Use Postgres 16. Use transactions and row locks for seat holds. Money is stored as integer cents.

## Consequences
Schema changes need migrations. The team already knows SQL, so this is cheap.
