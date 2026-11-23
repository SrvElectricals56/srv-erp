"""Server-owned visit reward evidence and account totals."""

from bisect import bisect_left

import frappe
from frappe.utils import get_datetime

from .policy import UNVERIFIED_INTERVAL, geofence, money


def near_seconds(center, samples, max_gap=300, max_accuracy=50, *, interruptions=()):
	"""Count only consecutive, precise samples inside the shop's 500 m fence."""
	accuracy = center.get("accuracy")
	if accuracy is None or not 0 <= accuracy <= max_accuracy or accuracy >= 500:
		return 0
	radius = 500 - accuracy
	interruptions = sorted(get_datetime(stamp) for stamp in interruptions)
	seconds = 0
	previous_at, previous_inside = None, False
	for sample in sorted(samples, key=lambda row: get_datetime(row["captured_at"])):
		captured_at = get_datetime(sample["captured_at"])
		inside = geofence(center, sample, radius=radius, max_accuracy=max_accuracy) == "Inside"
		verified = sample.get("verified", True)
		if previous_inside and inside and verified:
			gap = (captured_at - previous_at).total_seconds()
			interruption = bisect_left(interruptions, previous_at)
			if 0 < gap <= max_gap and (
				interruption == len(interruptions) or interruptions[interruption] > captured_at
			):
				seconds += gap
		# A fresh fix after a gap can anchor later time even though its incoming leg was unverified.
		received_at = sample.get("received_at")
		previous_inside = inside and (
			verified
			or (
				sample.get("rejection_reason") == UNVERIFIED_INTERVAL
				and received_at is not None
				and (get_datetime(received_at) - captured_at).total_seconds() <= max_gap
			)
		)
		previous_at = captured_at
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


def visit_evidence(row, ended_at, departure, max_gap=300, max_accuracy=50):
	start = row.get("reward_started_at")
	if not start:
		return 0, money(0), []
	start, ended_at = get_datetime(start), get_datetime(ended_at)
	# Retakes retain the original timer and photo audit row, even after its file is removed.
	center = frappe.db.get_value(
		"DSR Dealer Photo Evidence",
		{
			"activity": row.name,
			"duty": row.duty,
			"account": row.account,
			"received_at": start,
			"capture_source": ["in", ["Browser camera", "Enrolled Android camera"]],
		},
		["latitude", "longitude", "accuracy"],
		order_by="creation asc, name asc",
		as_dict=True,
	)
	seconds = 0
	if center:
		samples = frappe.get_all(
			"DSR GPS Point",
			filters={
				"duty": row.duty,
				"account": row.account,
				"captured_at": ["between", [start, ended_at]],
			},
			fields=[
				"latitude",
				"longitude",
				"accuracy",
				"captured_at",
				"received_at",
				"verified",
				"rejection_reason",
			],
			order_by="captured_at asc",
			limit_page_length=0,
		)
		tracking_scope = {"duty": row.duty, "account": row.account}
		status_at_start = frappe.db.get_value(
			"DSR Tracking Event",
			{
				**tracking_scope,
				"event_type": ["in", ["Interrupted", "Resumed"]],
				"recorded_at": ["<", start],
			},
			"event_type",
			order_by="recorded_at desc, creation desc, name desc",
		)
		interruptions = frappe.get_all(
			"DSR Tracking Event",
			filters={
				**tracking_scope,
				"event_type": "Interrupted",
				"recorded_at": ["between", [start, ended_at]],
			},
			pluck="recorded_at",
			limit_page_length=0,
		)
		samples.insert(0, dict(center, captured_at=start, verified=status_at_start != "Interrupted"))
		samples.append(dict(departure, captured_at=ended_at))
		seconds = near_seconds(center, samples, max_gap, max_accuracy, interruptions=interruptions)
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


def finalize_reward(row, ended_at, departure, max_gap=300, max_accuracy=50):
	"""Persist the submission snapshot atomically with completion, once per visit."""
	if row.get("reward_rule_version") or not row.get("reward_started_at"):
		return
	seconds, total, orders = visit_evidence(row, ended_at, departure, max_gap, max_accuracy)
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
