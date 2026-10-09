# Sprint 13 retrospective
Team: Tidewater booking platform | Date: 13 March 2026 | Facilitator: rotates

## What went well
- Seat hold with SELECT FOR UPDATE stopped double bookings in the load test with 40 parallel checkouts.
- Mocked payment sandbox: no flaky deploys this sprint.

## What did not go well
- The waitlist emails went out in English to Swedish customers because the locale was not passed through.
- Code review waiting times of up to two days.

## Actions
- Add locale to every notification job and a test for it (Noor).
- Review requests answered within four working hours (everyone).

## Mood
Average team mood this sprint (1-5): 3.9

## Format reminder
Ten minutes of silent writing, then everyone reads their notes aloud. We group similar notes, vote with three dots each and pick at most two actions, each with one owner. Actions from the last retro are checked first. What is said in the retro stays in the team.
