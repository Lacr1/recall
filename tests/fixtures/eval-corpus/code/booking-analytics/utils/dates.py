from datetime import date, timedelta
import re


def parse_since(text: str) -> date:
    """Accepts an ISO date (2026-01-01) or a phrase like '90 days ago'."""
    m = re.fullmatch(r"(\d+) days ago", text.strip())
    if m:
        return date.today() - timedelta(days=int(m.group(1)))
    return date.fromisoformat(text)
