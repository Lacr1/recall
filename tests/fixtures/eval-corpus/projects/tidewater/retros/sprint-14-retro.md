# Sprint 14 retrospective
Team: Tidewater booking platform | Date: 27 March 2026 | Facilitator: rotates

## What went well
- Availability calendar demo to Acme went well; Jonas signed off the design.
- Database migration 006 added the index on reservations and the availability query went from 900 ms to 40 ms.

## What did not go well
- On-call was noisy: 31 alerts in one night from the webhook retry queue, none of them real problems.
- Nobody owned the staging database clean-up.

## Actions
- Raise the webhook retry alert threshold and group alerts per hour (Viktor).
- Weekly staging reset by script on Sunday night (Karin).

## Mood
Average team mood this sprint (1-5): 4.1

## Format reminder
Ten minutes of silent writing, then everyone reads their notes aloud. We group similar notes, vote with three dots each and pick at most two actions, each with one owner. Actions from the last retro are checked first. What is said in the retro stays in the team.
