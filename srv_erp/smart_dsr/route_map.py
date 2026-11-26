"""Build display-only route segments without joining missing or implausible GPS intervals."""

from itertools import pairwise

from frappe.utils import get_datetime

from .policy import UNVERIFIED_INTERVAL, distance


def route_segments(points, max_gap=300, max_speed=160, max_accuracy=50):
	segments, gaps = [], []
	for previous, current in pairwise(points):
		seconds = (
			get_datetime(current["captured_at"]) - get_datetime(previous["captured_at"])
		).total_seconds()
		km = distance(previous, current)
		if (
			current.get("rejection_reason") == UNVERIFIED_INTERVAL
			or not 0 < seconds <= max_gap
			or km / (seconds / 3600) > max_speed
		):
			gaps.append(
				{
					"from": previous["captured_at"],
					"to": current["captured_at"],
					"latitude": current["latitude"],
					"longitude": current["longitude"],
					"reason": "Tracking gap or implausible movement",
				}
			)
			continue
		if max(previous["accuracy"], current["accuracy"]) > 1000:
			gaps.append(
				{
					"from": previous["captured_at"],
					"to": current["captured_at"],
					"latitude": current["latitude"],
					"longitude": current["longitude"],
					"reason": "Location too imprecise",
				}
			)
			continue
		kind = (
			"verified"
			if current["verified"] and max(previous["accuracy"], current["accuracy"]) <= max_accuracy
			else "approximate"
		)
		start = [previous["latitude"], previous["longitude"]]
		end = [current["latitude"], current["longitude"]]
		if (
			segments
			and segments[-1]["kind"] == kind
			and segments[-1]["coordinates"][-1] == start
			and segments[-1]["ended_at"] == previous["captured_at"]
		):
			segments[-1]["coordinates"].append(end)
			segments[-1]["ended_at"] = current["captured_at"]
		else:
			segments.append(
				{
					"kind": kind,
					"coordinates": [start, end],
					"started_at": previous["captured_at"],
					"ended_at": current["captured_at"],
				}
			)
	return segments, gaps
