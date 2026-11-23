"""Pure monetary and location rules, also exercised without a running site."""

from decimal import ROUND_HALF_UP, Decimal
from math import asin, cos, isfinite, radians, sin, sqrt


def money(value):
	value = Decimal(str(value or 0))
	if not value.is_finite():
		raise ValueError("Amount must be finite.")
	return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def coordinates(lat, lon, accuracy):
	lat, lon, accuracy = float(lat), float(lon), float(accuracy)
	if (
		not all(isfinite(x) for x in (lat, lon, accuracy))
		or not -90 <= lat <= 90
		or not -180 <= lon <= 180
		or accuracy < 0
	):
		raise ValueError("Invalid GPS coordinates or accuracy.")
	return lat, lon, accuracy


def distance(a, b):
	lat1, lon1, lat2, lon2 = map(radians, (a["latitude"], a["longitude"], b["latitude"], b["longitude"]))
	return (
		6371
		* 2
		* asin(
			min(1, sqrt(sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin((lon2 - lon1) / 2) ** 2))
		)
	)


def segment(previous, point, seconds, max_accuracy=50, max_speed=160, max_gap=300):
	coordinates(point["latitude"], point["longitude"], point["accuracy"])
	if point["accuracy"] > max_accuracy:
		return 0, "Poor accuracy"
	if not previous:
		return 0, ""
	if seconds <= 0 or seconds > max_gap:
		return 0, "Unverified interval"
	km = distance(previous, point)
	if km / (seconds / 3600) > max_speed:
		return 0, "Implausible speed"
	if previous["accuracy"] > max_accuracy:
		return 0, "Previous point unverified"
	# Ignore displacement within measurement uncertainty instead of paying for stationary drift.
	if km * 1000 <= max(previous["accuracy"], point["accuracy"]):
		return 0, ""
	return km, ""


def estimated_segment(previous, point, seconds, max_speed=160, max_gap=300):
	"""Conservative displacement estimate; never a verified/reimbursable distance."""
	if not previous or not 0 < seconds <= max_gap:
		return 0
	if max(previous["accuracy"], point["accuracy"]) > 1000:
		return 0
	km = distance(previous, point)
	if km / (seconds / 3600) > max_speed:
		return 0
	return max(0, km - (previous["accuracy"] + point["accuracy"]) / 1000)


def geofence(center, point, radius=500, max_accuracy=50):
	if not point or point["accuracy"] > max_accuracy:
		return "Unknown"
	meters = distance(center, point) * 1000
	if meters - point["accuracy"] > radius:
		return "Outside"
	if meters + point["accuracy"] <= radius:
		return "Inside"
	return "Unknown"


def balance(opening, movements):
	return money(money(opening) + sum((money(x) for x in movements), Decimal(0)))


def positive_quantity(value):
	"""ERP quantities retain fractional precision and are not currency amounts."""
	number = float(value)
	if not isfinite(number) or number <= 0:
		raise ValueError("Quantity must be positive and finite.")
	return number


# Current State/UT marks and retained historical marks on existing vehicles.
INDIAN_REGISTRATION_CODES = frozenset(
	"AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS TG UK UA UP WB".split()
)


def indian_vehicle_number(value):
	"""Normalize supported permanent State/UT and BH marks; not a VAHAN lookup."""
	import re

	if not isinstance(value, str) or len(value) > 30 or not re.fullmatch(r"[A-Za-z0-9\s-]+", value, re.ASCII):
		raise ValueError("Enter an Indian vehicle number, for example PB31AB1234 or 22BH1234AA.")
	number = re.sub(r"[\s-]", "", value, flags=re.ASCII).upper()
	bh = re.fullmatch(r"(2[1-9]|[3-9][0-9])BH([0-9]{4})([A-HJ-NP-Z]{1,2})", number)
	if bh and int(bh[2]) > 0:
		return number
	state = re.fullmatch(r"([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{1,4})", number)
	if state and state[1] in INDIAN_REGISTRATION_CODES and int(state[2]) > 0 and int(state[4]) > 0:
		return state[1] + state[2] + state[3] + state[4].zfill(4)
	raise ValueError("Enter an Indian vehicle number, for example PB31AB1234 or 22BH1234AA.")
