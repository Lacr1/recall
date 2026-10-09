"""No-show report: which trips and weekdays have the most people who booked but did not turn up."""
import argparse
import pandas as pd
import psycopg

from utils.dates import parse_since

QUERY = """
SELECT t.name AS trip, d.date, r.seats, r.attended
FROM reservations r
JOIN departures d ON d.id = r.departure_id
JOIN trips t ON t.id = d.trip_id
WHERE r.status = 'confirmed' AND d.date >= %(since)s AND d.date < now()
"""


def no_show_rates(df: pd.DataFrame) -> pd.DataFrame:
    df = df.assign(weekday=pd.to_datetime(df["date"]).dt.day_name(), missed=df["seats"] - df["attended"])
    grouped = df.groupby(["trip", "weekday"]).agg(booked=("seats", "sum"), missed=("missed", "sum"))
    grouped["no_show_rate"] = (grouped["missed"] / grouped["booked"]).round(3)
    return grouped.sort_values("no_show_rate", ascending=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="90 days ago")
    parser.add_argument("--out", default="no_show_report.csv")
    args = parser.parse_args()
    with psycopg.connect() as conn:
        df = pd.read_sql(QUERY, conn, params={"since": parse_since(args.since)})
    no_show_rates(df).to_csv(args.out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
