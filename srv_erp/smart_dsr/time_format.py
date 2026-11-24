"""Readable date and duration values for reports; stored values stay unchanged."""

import re
from math import isfinite


def duration_field(key):
	return bool(re.search(r"_(seconds|minutes|hours)$", key))


def duration_label(key):
	return {
		"duty_minutes": "Duty Time",
		"travel_duration_seconds": "Travel Time",
		"activity_duration_minutes": "Visit Duration",
		"reward_near_seconds": "Verified Time Near Dealer",
	}.get(key, re.sub(r"_(seconds|minutes|hours)$", "", key).replace("_", " ").title())


def display_duration(key, value):
	if value is None or value == "":
		return "—"
	try:
		seconds = float(value) * (3600 if key.endswith("_hours") else 60 if key.endswith("_minutes") else 1)
	except (ValueError, TypeError):
		return "—"
	if not isfinite(seconds):
		return "—"
	seconds = max(0, seconds)
	if 0 < seconds < 60:
		return "<1 min"
	minutes = int(seconds // 60)
	hours, remaining = divmod(minutes, 60)
	return (f"{hours} hr" + (f" {remaining} min" if remaining else "")) if hours else f"{minutes} min"


def date_field(key):
	return key in ("date", "creation", "modified", "posting_time") or bool(
		re.search(r"_(date|expiry|at)$", key)
	)


def display_date(key, value):
	from datetime import date, datetime
	from zoneinfo import ZoneInfo

	if value is None or value == "":
		return "—"
	try:
		if isinstance(value, date) and not isinstance(value, datetime):
			return value.strftime("%d-%m-%y")
		stamp = (
			value
			if isinstance(value, datetime)
			else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
		)
		if stamp.tzinfo:
			stamp = stamp.astimezone(ZoneInfo("Asia/Kolkata"))
		result = stamp.strftime("%d-%m-%y")
		with_time = (
			key.endswith("_at")
			or key in ("creation", "modified", "posting_time")
			or bool(re.search(r"\d[T ]\d{2}:\d{2}", str(value)))
		)
		return result + (stamp.strftime(", %I:%M %p").lower() if with_time else "")
	except (ValueError, TypeError):
		return str(value)
