"""Daily automatic meal expenses during continuous duty, scheduled explicitly in India time."""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

import frappe
from frappe.utils import get_datetime, get_system_timezone, getdate, now_datetime

from . import api

INDIA = ZoneInfo("Asia/Kolkata")
MEALS = (
	("Breakfast", time(7), time(7, 5), 100, True),
	("Lunch", time(13), time(13, 30), 150, False),
	("Dinner", time(18), time(21, 30), 150, False),
)


def india_time(value):
	value = get_datetime(value)
	if value.tzinfo is None:
		value = value.replace(tzinfo=ZoneInfo(get_system_timezone()))
	return value.astimezone(INDIA)


def site_time(value):
	return value.astimezone(ZoneInfo(get_system_timezone())).replace(tzinfo=None)


def due_meals(started, as_of, workday=None):
	"""Pure cutoff rules; caller supplies the start of the current continuous ON interval."""
	day = workday or started.date()
	while day <= as_of.date():
		for name, cutoff, scheduled, amount, inclusive in MEALS:
			cutoff_at = datetime.combine(day, cutoff, tzinfo=INDIA)
			scheduled_at = datetime.combine(day, scheduled, tzinfo=INDIA)
			eligible = started <= cutoff_at if inclusive else started < cutoff_at
			if eligible and as_of >= scheduled_at:
				yield name, amount, scheduled_at
		day += timedelta(days=1)


def automatic_meals_enabled(doc):
	start_date = frappe.db.get_single_value("DSR Settings", "automatic_meal_expenses_from")
	return bool(
		start_date
		and str(start_date) != "0001-01-01"
		and doc.started_at
		and india_time(doc.started_at).date() >= getdate(start_date)
	)


def continuous_start(doc):
	started = india_time(doc.started_at)
	for row in frappe.get_all(
		"DSR Admin Audit",
		filters={
			"record_type": "DSR Duty Session",
			"record_id": doc.name,
			"action": "reopen",
			"outcome": "Applied",
		},
		fields=["recorded_at"],
		limit_page_length=0,
	):
		started = max(started, india_time(row.recorded_at))
	return started


def post_due_meals(doc, as_of=None):
	"""Caller holds the User and duty locks. Never mutate a closed or finalized DSR."""
	if doc.status != "Active" or doc.get("no_visit_duty") or not automatic_meals_enabled(doc):
		return []
	as_of = india_time(as_of or now_datetime())
	day = india_time(doc.started_at).date()
	posted = []
	for name, amount, scheduled in due_meals(continuous_start(doc), as_of, day):
		request_key = f"automatic-meal:{scheduled.date()}:{name}"
		if api.repeated("DSR Expense Record", request_key, doc.account):
			continue
		stamp = site_time(scheduled)
		remarks = (
			f"Automatic {name.lower()} expense for continuous duty at {scheduled.strftime('%I:%M %p')} IST."
		)
		row = api.insert(
			"DSR Expense Record",
			account=doc.account,
			duty=doc.name,
			category=name,
			amount=amount,
			paid_from_cash=1,
			recorded_at=stamp,
			remarks=remarks,
			request_key=api.key(request_key, doc.account),
		)
		movement = api.ledger(
			doc, "Cash Expense", -amount, row.doctype, row.name, "expense:" + row.name, remarks
		)
		movement.posting_time = stamp
		api.save(movement)
		posted.append(row.name)
	if posted:
		api.recalculate(doc)
		api.save(doc)
	return posted


def post_scheduled_meals():
	"""Runs without an open browser; serialized with all other User duty mutations."""
	for name in frappe.get_all(
		"DSR Duty Session", filters={"status": "Active"}, pluck="name", limit_page_length=0
	):
		doc = frappe.get_doc("DSR Duty Session", name)
		if not doc.account:
			continue
		frappe.db.sql("select name from `tabUser` where name=%s for update", doc.account)
		doc = frappe.get_doc("DSR Duty Session", name, for_update=True)
		post_due_meals(doc)


def legacy_allowance(doc):
	if doc.get("no_visit_duty") or automatic_meals_enabled(doc):
		return 0.0
	return float(
		frappe.db.sql("select coalesce(sum(allowance),0) from `tabDSR Break` where duty=%s", doc.name)[0][0]
	)


def legacy_allowance_total(duties):
	if not duties:
		return 0.0
	start_date = frappe.db.get_single_value("DSR Settings", "automatic_meal_expenses_from")
	rows = frappe.get_all(
		"DSR Duty Session",
		filters={"name": ["in", duties]},
		fields=["name", "started_at", "no_visit_duty"],
		limit_page_length=0,
	)
	legacy = [
		row.name
		for row in rows
		if not row.get("no_visit_duty")
		and (
			not start_date
			or str(start_date) == "0001-01-01"
			or not row.started_at
			or india_time(row.started_at).date() < getdate(start_date)
		)
	]
	if not legacy:
		return 0.0
	return float(
		frappe.db.sql(
			"select coalesce(sum(allowance),0) from `tabDSR Break` where duty in %(duties)s",
			{"duties": tuple(legacy)},
		)[0][0]
	)
