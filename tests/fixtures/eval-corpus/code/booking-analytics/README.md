# booking-analytics

Python scripts that read a nightly copy of the booking database and produce CSV reports for trip operators and clinics.

- no_show_report.py: share of booked people who did not turn up, per trip and weekday
- revenue_by_month.py: revenue, refunds and net revenue per month
- queries/top_routes.sql: most booked trips over the last 12 months

Run with: python no_show_report.py --since 2026-01-01
