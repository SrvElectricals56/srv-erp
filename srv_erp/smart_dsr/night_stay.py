"""Eligibility and once-only cash expense for an overnight stay."""

from datetime import datetime, time, timedelta

import frappe
from frappe.utils import get_datetime

from . import api
from .meal_expenses import INDIA, continuous_start, india_time
from .policy import distance, geofence


def eligibility(doc):
	now = india_time(api.now_datetime())
	gate = datetime.combine(now.date(), time(21, 30), tzinfo=INDIA)
	if now < gate:
		gate -= timedelta(days=1)
	started = continuous_start(doc)
	seconds = api.duty_seconds(doc)
	passed = started <= gate
	return {
		"eligible": doc.status == "Active" and passed and seconds >= 43200,
		"night_date": gate.date(),
		"duty_hours": seconds / 3600,
		"message": "Night Stay ON requires duty to continue through 9:30 PM IST and at least 12 hours of duty.",
	}


def state(doc):
	rows = frappe.get_all(
		"DSR Night Stay",
		filters={"account": doc.account, "duty": doc.name},
		fields=[
			"name",
			"latitude",
			"longitude",
			"accuracy",
			"checked_in_at",
			"checked_out_at",
			"checkout_latitude",
			"checkout_longitude",
			"checkout_accuracy",
			"checkout_distance_m",
			"duration_minutes",
			"expense",
			"expense_amount",
			"night_key",
		],
		order_by="creation desc",
		limit_page_length=0,
	)
	current = next((row for row in rows if not row.checked_out_at), None)
	result = eligibility(doc)
	result.update(
		active=current,
		latest=rows[0] if rows else None,
		can_on=False,
		can_off=False,
		max_accuracy_m=float(api.settings().max_accuracy_m),
	)
	if current:
		result["off_available_at"] = get_datetime(current.checked_in_at) + timedelta(hours=4)
		result["can_off"] = doc.status == "Active" and api.now_datetime() >= result["off_available_at"]
	else:
		night_key = api.key("night-stay:" + str(result["night_date"]), doc.account)
		used = frappe.db.exists("DSR Night Stay", {"night_key": night_key})
		result["can_on"] = result["eligible"] and not used
		if used:
			result["message"] = "Night stay is already recorded for this night."
	return result


def turn_on(duty, gps, address, request_key):
	doc = api.active(duty)
	prior = api.repeated("DSR Night Stay", request_key, doc.account)
	if prior:
		if prior.duty != doc.name:
			frappe.throw("Night stay request belongs to a different duty.", frappe.PermissionError)
		return prior.name
	allowed = eligibility(doc)
	if not allowed["eligible"]:
		frappe.throw(allowed["message"])
	if api.locked_exists("DSR Night Stay", {"account": doc.account, "checked_out_at": ["is", "not set"]}):
		frappe.throw("A night stay is already active.")
	night_key = api.key("night-stay:" + str(allowed["night_date"]), doc.account)
	if api.locked_exists("DSR Night Stay", {"night_key": night_key}):
		frappe.throw("Night stay is already recorded for this night.")
	point = api.location(gps, require_precise=True)
	return api.insert(
		"DSR Night Stay",
		account=doc.account,
		duty=doc.name,
		**point,
		address=str(address or "")[:2000],
		checked_in_at=api.now_datetime(),
		night_date=allowed["night_date"],
		night_key=night_key,
		request_key=api.key(request_key, doc.account),
	).name


def turn_off(stay, gps):
	account = api.identity(True)
	row = frappe.get_doc("DSR Night Stay", stay, for_update=True)
	if row.account != account:
		frappe.throw("Unauthorized night stay.", frappe.PermissionError)
	if row.checked_out_at:
		return row.name
	doc = api.active(row.duty)
	now = api.now_datetime()
	elapsed = (now - get_datetime(row.checked_in_at)).total_seconds()
	if elapsed < 14400:
		frappe.throw("Night Stay OFF is available after at least 4 hours.")
	point = api.location(gps, require_precise=True)
	if (
		geofence(row.as_dict(), point, radius=500, max_accuracy=float(api.settings().max_accuracy_m))
		!= "Inside"
	):
		frappe.throw(
			"Return within 500 metres of the Night Stay ON location and obtain an accurate location before switching OFF."
		)
	result = api.record_expense_document(
		doc,
		"Night Stay",
		1200,
		1,
		"automatic-night-stay:" + row.name,
		"Automatic night stay expense after at least 4 hours and return within 500 metres.",
	)
	row.checked_out_at = now
	row.checkout_latitude, row.checkout_longitude, row.checkout_accuracy = (
		point["latitude"],
		point["longitude"],
		point["accuracy"],
	)
	row.checkout_distance_m = distance(row.as_dict(), point) * 1000
	row.duration_minutes = elapsed / 60
	row.expense, row.expense_amount, row.state = result["name"], 1200, "Inside"
	api.save(row)
	api.recalculate(doc)
	api.save(doc)
	return row.name


def duty_off_wait(doc):
	"""Require two hours ON after the latest checkout on this duty."""
	from math import ceil

	rows = frappe.get_all(
		"DSR Night Stay",
		filters={"account": doc.account, "duty": doc.name, "checked_out_at": ["is", "set"]},
		fields=["checked_out_at"],
		order_by="checked_out_at desc",
		limit_page_length=1,
	)
	if not rows or doc.status != "Active":
		return {"remaining_seconds": 0, "message": ""}
	start, now = get_datetime(rows[0].checked_out_at), api.now_datetime()
	on_seconds = max(0, (now - max(start, get_datetime(doc.started_at))).total_seconds())
	# Reopened duties must not count time spent OFF towards the two hours.
	if frappe.db.exists("DocType", "DSR Admin Audit"):
		for entry in frappe.get_all(
			"DSR Admin Audit",
			filters={
				"record_type": "DSR Duty Session",
				"record_id": doc.name,
				"action": "reopen",
				"outcome": "Applied",
			},
			fields=["original_value", "recorded_at"],
			limit_page_length=0,
		):
			previous = frappe.parse_json(entry.original_value or "{}")
			if previous.get("ended_at"):
				on_seconds -= max(
					0,
					(
						min(now, get_datetime(entry.recorded_at))
						- max(start, get_datetime(previous["ended_at"]))
					).total_seconds(),
				)
	remaining = max(0, ceil(7200 - max(0, on_seconds)))
	return {
		"remaining_seconds": remaining,
		"message": f"Duty OFF requires at least 2 hours of Duty ON time after Night Stay OFF. Please continue duty for another {ceil(remaining / 60)} minute(s)."
		if remaining
		else "",
	}
