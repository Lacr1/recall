"""Sets the heat pump target temperature by time of day. Lower at night and when nobody is home."""
from datetime import datetime
import yaml

from heatpump import IlmaClient


def target_for(now: datetime, schedule: dict, away: bool) -> float:
    if away:
        return schedule["away"]
    hour = now.hour
    if hour < 6 or hour >= 23:
        return schedule["night"]
    if now.weekday() < 5 and 9 <= hour < 16:
        return schedule["workday"]
    return schedule["home"]


def main() -> None:
    with open("config.yaml") as f:
        cfg = yaml.safe_load(f)
    client = IlmaClient(cfg["heatpump"]["host"])
    client.set_target(target_for(datetime.now(), cfg["schedule"], client.everyone_away()))


if __name__ == "__main__":
    main()
