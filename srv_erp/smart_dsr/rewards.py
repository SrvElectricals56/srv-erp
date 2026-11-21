"""Server-owned visit reward evidence and account totals."""

import frappe
from frappe.utils import get_datetime

from .policy import geofence, money


def near_seconds(center, samples, max_gap=300):
	"""Count only consecutive, precise samples inside the shop's 500 m fence."""
	seconds = 0
	previous = None
	for sample in sorted(samples, key=lambda row: get_datetime(row["captured_at"])):
		inside = geofence(center, sample) == "Inside" and sample.get("verified", True)
		if previous and inside and previous[1]:
			gap = (
				get_datetime(sample["captured_at"]) - get_datetime(previous[0]["captured_at"])
			).total_seconds()
			if 0 < gap <= max_gap:
				seconds += gap
		previous = (sample, inside)
	return seconds


def start_timer(row, evidence):
	"""A successful upload starts the timer; retakes keep the original start."""
	if row.get("reward_started_at"):
		return
	from . import api

	row.reward_started_at = evidence.received_at
	row.reward_latitude = evidence.latitude
	row.reward_longitude = evidence.longitude
	api.save(row)


def visit_evidence(row, ended_at, departure, max_gap=300):
	start = row.get("reward_started_at")
	if not start:
		return 0, money(0), []
	start, ended_at = get_datetime(start), get_datetime(ended_at)
	center = {"latitude": row.reward_latitude, "longitude": row.reward_longitude}
	samples = frappe.get_all(
		"DSR GPS Point",
		filters={
			"duty": row.duty,
			"account": row.account,
			"captured_at": ["between", [start, ended_at]],
		},
		fields=["latitude", "longitude", "accuracy", "captured_at", "verified"],
		order_by="captured_at asc",
		limit_page_length=0,
	)
	# Uploaded photo and submission GPS provide trusted interval endpoints.
	samples.insert(0, dict(center, accuracy=0, captured_at=start, verified=True))
	samples.append(dict(departure, captured_at=ended_at, verified=True))
	seconds = near_seconds(center, samples, max_gap)
	orders = frappe.get_all(
		"Sales Order",
		filters={
			"custom_dsr_visit": row.name,
			"customer": row.customer,
			"docstatus": ["<", 2],
			"creation": ["between", [start, ended_at]],
		},
		fields=["name", "grand_total", "base_grand_total", "currency", "company"],
		limit_page_length=0,
	)
	total = money(0)
	accepted = []
	for order in orders:
		company_currency = frappe.get_cached_value("Company", order.company, "default_currency")
		if order.currency == "INR":
			amount = money(order.grand_total)
		elif company_currency == "INR":
			amount = money(order.base_grand_total)
		else:
			continue
		total += amount
		accepted.append({"order": order.name, "amount_inr": str(amount)})
	return seconds, total, accepted


def total_points(account):
	return float(
		money(
			frappe.db.sql(
				"""select coalesce(sum(reward_points), 0)
		from `tabDSR Dealer Activity` where account=%s and status='Completed'
		and reward_rule_version > 0""",
				account,
			)[0][0]
		)
	)


REWARD_BANDS = (
	(1800, 20000, 40000, 1),
	(3600, 75000, 150000, 2),
	(7200, 200000, 300000, 3),
	(10800, 300000, 400000, 4),
	(float("inf"), 400000, 500000, 5),
)


def reward_band(seconds):
	return next(
		(minimum, per_point, multiplier)
		for ceiling, minimum, per_point, multiplier in REWARD_BANDS
		if seconds <= ceiling
	)


def score_visit(seconds, order_amount):
	"""Image policy: -1 below minimum, zero middle band, whole positive points."""
	minimum, per_point, multiplier = reward_band(seconds)
	amount = money(order_amount)
	points = -1 if amount < minimum else int(amount // per_point) * multiplier
	return points, per_point, 1


def finalize_reward(row, ended_at, departure, max_gap=300):
	"""Persist the submission snapshot atomically with completion, once per visit."""
	if row.get("reward_rule_version") or not row.get("reward_started_at"):
		return
	seconds, total, orders = visit_evidence(row, ended_at, departure, max_gap)
	points, threshold, penalty = score_visit(seconds, total)
	row.reward_near_seconds = seconds
	row.reward_order_amount = total
	row.reward_points = points
	row.reward_rule_version = 4
	row.reward_calculation = frappe.as_json(
		{
			"version": 4,
			"started_at": row.reward_started_at,
			"submitted_at": ended_at,
			"near_seconds": seconds,
			"radius_m": 500,
			"max_gap_seconds": max_gap,
			"order_amount_inr": str(total),
			"orders": orders,
			"minimum_order_amount": reward_band(seconds)[0],
			"qualifying_amount": threshold,
			"points_per_multiple": reward_band(seconds)[2],
			"below_target_penalty": penalty,
			"points": points,
		}
	)
