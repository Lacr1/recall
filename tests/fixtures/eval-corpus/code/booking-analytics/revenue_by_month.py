"""Monthly revenue report: gross bookings, refunds and net revenue in euro."""
import pandas as pd
import psycopg

GROSS = "SELECT date_trunc('month', confirmed_at) AS month, SUM(price_cents) AS gross FROM reservations WHERE status IN ('confirmed', 'cancelled') GROUP BY 1"
REFUNDS = "SELECT date_trunc('month', created_at) AS month, SUM(amount_cents) AS refunded FROM refunds WHERE status = 'completed' GROUP BY 1"


def revenue_table(conn) -> pd.DataFrame:
    gross = pd.read_sql(GROSS, conn).set_index("month")
    refunds = pd.read_sql(REFUNDS, conn).set_index("month")
    table = gross.join(refunds, how="left").fillna(0)
    table["net"] = table["gross"] - table["refunded"]
    return (table / 100).round(2)


if __name__ == "__main__":
    with psycopg.connect() as conn:
        print(revenue_table(conn).to_string())
