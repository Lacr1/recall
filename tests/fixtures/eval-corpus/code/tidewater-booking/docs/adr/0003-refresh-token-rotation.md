# ADR 0003: Rotate refresh tokens and detect reuse

Status: accepted, February 2026

## Context
Guides stay signed in to the admin app on shared tablets at trip bases. A stolen refresh token used to be valid for 30 days.

## Decision
Each refresh token can be used once. Using it returns a new access token and a new refresh token in the same family. If a used token is presented again, the whole family is revoked and the user must sign in again.

## Consequences
Two browser tabs refreshing at the same moment can log a user out. We accept this; the admin app refreshes from one place only.
