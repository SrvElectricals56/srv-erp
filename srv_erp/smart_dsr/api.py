"""Authenticated Smart DSR operations. Frappe commits successful POSTs atomically.

User row locks serialize all financial and duty mutations, including first duty.
No client-supplied owner, opening balance, calculated amount, or server time is accepted.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import secrets
from datetime import datetime, timedelta
from itertools import pairwise
from zoneinfo import ZoneInfo

import frappe
from frappe.utils import cint, flt, get_datetime, getdate, now_datetime

from .admin_permissions import is_admin, require_finance
from .policy import (
	UNVERIFIED_INTERVAL,
	balance,
	coordinates,
	estimated_segment,
	geofence,
	indian_vehicle_number,
	money,
	positive_quantity,
	segment,
)
from .security import account_for


def capture_time(value):
	stamp = get_datetime(value)
	if stamp.tzinfo is not None:
		from frappe.utils import get_system_timezone

		stamp = stamp.astimezone(ZoneInfo(get_system_timezone())).replace(tzinfo=None)
	return stamp


def public_dates(value):
	# Send explicit offsets to devices that travel outside the site's time zone.
	if isinstance(value, datetime):
		from frappe.utils import get_system_timezone

		return value.replace(tzinfo=ZoneInfo(get_system_timezone())).isoformat()
	if isinstance(value, dict):
		return {key: public_dates(item) for key, item in value.items()}
	if isinstance(value, list):
		return [public_dates(item) for item in value]
	return value


def settings():
	s = frappe.get_single("DSR Settings")
	if not s.company:
		frappe.throw("Administrator must configure DSR Settings before starting duty.")
	return s


def identity(lock=False):
	return account_for(lock=lock)


def insert(doctype, **values):
	doc = frappe.get_doc(dict(doctype=doctype, **values))
	doc.flags.smart_dsr_write = True
	return doc.insert(ignore_permissions=True)


def save(doc):
	doc.flags.smart_dsr_write = True
	return doc.save(ignore_permissions=True)


def duty_doc(duty, mutable=False):
	account = identity(lock=mutable)
	doc = frappe.get_doc("DSR Duty Session", duty, for_update=mutable)
	if doc.account != account:
		frappe.throw("This duty belongs to another account.", frappe.PermissionError)
	if mutable and doc.status == "Finalized":
		frappe.throw("This DSR is finalized.")
	return doc


def active(duty):
	doc = duty_doc(duty, True)
	if doc.status != "Active":
		frappe.throw("Duty must be ON for this operation.")
	return doc


def key(value, account):
	if not isinstance(value, str) or not 8 <= len(value) <= 128:
		frappe.throw("A stable request identifier of 8-128 characters is required.")
	return hashlib.sha256((account + ":" + value).encode()).hexdigest()


def repeated(doctype, request_key, account):
	name = frappe.db.get_value(doctype, {"request_key": key(request_key, account)}, "name", for_update=True)
	if not name:
		for legacy in frappe.get_all(
			doctype,
			filters={"account": account, "employee": ["is", "set"]},
			pluck="employee",
			distinct=True,
			limit_page_length=0,
		):
			name = frappe.db.get_value(
				doctype,
				{"request_key": key(request_key, legacy), "account": account},
				"name",
				for_update=True,
			)
			if name:
				break
	return frappe.get_doc(doctype, name, for_update=True) if name else None


def locked_exists(doctype, filters):
	return bool(frappe.db.get_value(doctype, filters, "name", for_update=True))


def amount(value):
	try:
		value = money(value)
	except (ValueError, ArithmeticError):
		frappe.throw("Enter a valid amount.")
	if value <= 0:
		frappe.throw("Amount must be greater than zero.")
	return float(value)


def quantity(value):
	try:
		return positive_quantity(value)
	except (ValueError, TypeError, OverflowError):
		frappe.throw("Enter a positive, finite quantity.")


def location(value, require_precise=False):
	value = frappe.parse_json(value) if isinstance(value, str) else value
	if not isinstance(value, dict):
		frappe.throw("A current GPS location is required.")
	try:
		lat, lon, accuracy = coordinates(value["latitude"], value["longitude"], value["accuracy"])
	except (ValueError, TypeError, KeyError):
		frappe.throw("GPS location is invalid.")
	if require_precise and accuracy > flt(settings().max_accuracy_m):
		frappe.throw("GPS accuracy is insufficient. Move outdoors and retry.")
	return dict(latitude=lat, longitude=lon, accuracy=accuracy)


def ledger(duty, kind, value, source_type, source_name, request_key, remarks=None):
	# Duty mutations are serialized by the User lock; unique keys provide a second guard.
	return insert(
		"DSR Cash Ledger",
		account=duty.account,
		duty=duty.name,
		transaction_type=kind,
		amount=float(money(value)),
		source_type=source_type,
		source_name=source_name,
		request_key=key(request_key, duty.account),
		posting_time=now_datetime(),
		remarks=remarks,
	)


def cash_movements(doc, as_of=None, lock=False):
	"""Return balance movements, excluding user-entered expenses but retaining system benefits."""
	query = """select name, amount, transaction_type, source_type, source_name
		from `tabDSR Cash Ledger` where duty=%s and transaction_type!='Opening'"""
	params = [doc.name]
	if as_of:
		query += " and posting_time<=%s"
		params.append(as_of)
	if lock:
		query += " for update"
	movements = frappe.db.sql(query, tuple(params), as_dict=True)
	expenses = frappe.get_all(
		"DSR Expense Record", filters={"duty": doc.name}, fields=["name", "category"], limit_page_length=0
	)
	manual_expenses = {
		row.name for row in expenses if row.category not in ("Breakfast", "Lunch", "Dinner", "Night Stay")
	}
	manual_ledger = {
		row.name
		for row in movements
		if row.source_type == "DSR Expense Record" and row.source_name in manual_expenses
	}
	return [
		row.amount
		for row in movements
		if not (
			(row.source_type == "DSR Expense Record" and row.source_name in manual_expenses)
			or (
				row.transaction_type == "Reversal"
				and row.source_type == "DSR Cash Ledger"
				and row.source_name in manual_ledger
			)
		)
	]


def cash_balance(doc):
	# Locking reads see the latest committed ledger even under REPEATABLE READ.
	if not doc.name:
		from .cash_allocations import balances, latest_duty

		return balances(doc.account, latest_duty(doc.account))["closing_balance"]
	return float(balance(doc.opening_balance, cash_movements(doc, lock=True)))


def event(doc, kind, details=""):
	return insert(
		"DSR Tracking Event",
		account=doc.account,
		duty=doc.name,
		event_type=kind,
		details=details,
		recorded_at=now_datetime(),
	)


def notify(doc, subject):
	manager = settings().manager_user
	if manager:
		frappe.get_doc(
			{
				"doctype": "Notification Log",
				"subject": subject,
				"for_user": manager,
				"type": "Alert",
				"document_type": doc.doctype,
				"document_name": doc.name,
			}
		).insert(ignore_permissions=True)


@frappe.whitelist()
def bootstrap():
	account = identity()
	profile = frappe.get_doc("User", account)
	sales = frappe.db.get_value(
		"Sales Person", {"enabled": 1, "sales_user": account}, ["name", "sales_user"], as_dict=True
	)
	from .rewards import total_points

	configuration = frappe.get_single("DSR Settings")
	vehicles = available_vehicles()
	duties = frappe.get_all(
		"DSR Duty Session",
		filters={"account": account},
		fields=[
			"name",
			"status",
			"work_date",
			"no_visit_duty",
			"opening_balance",
			"closing_balance",
			"verified_km",
			"fuel_rate",
			"started_at",
		],
		order_by="work_date desc, creation desc",
		limit_page_length=0,
	)
	if duties:
		from .meal_expenses import automatic_meals_enabled

		by_name = {row.name: row for row in duties}
		for row in duties:
			row.expense_total = fuel_entitlement(row)
			row.closing_balance = cash_balance(row)
		filters = {"account": account, "duty": ["in", list(by_name)]}
		for expense in frappe.get_all(
			"DSR Expense Record",
			filters={
				**filters,
				"category": ["!=", "Fuel Reimbursement"],
				"posting_status": ["!=", "Reversed"],
			},
			fields=["duty", "amount"],
			limit_page_length=0,
		):
			by_name[expense.duty].expense_total += flt(expense.amount)
		legacy = {row.name for row in duties if not row.no_visit_duty and not automatic_meals_enabled(row)}
		if legacy:
			for meal in frappe.get_all(
				"DSR Break",
				filters={**filters, "duty": ["in", list(legacy)]},
				fields=["duty", "allowance"],
				limit_page_length=0,
			):
				by_name[meal.duty].expense_total += flt(meal.allowance)
		for row in duties:
			row.expense_total = float(money(row.expense_total))
	current = duties[0].name if duties else None
	from .cash_allocations import balances as account_balances

	current_summary = summary(current) if current else None
	doc = frappe.get_doc("DSR Duty Session", current) if current else None
	current_balances = account_balances(account, doc)
	official_opening = current_balances["opening_balance"]
	if current_summary:
		current_summary["available_cash"] = current_balances["closing_balance"]
	overdue_rows = allocated_dealer_overdues()["rows"]
	return {
		"overdue_count": sum(int(row["entry_count"]) for row in overdue_rows),
		"overdue_party_count": len({row["customer"] for row in overdue_rows}),
		"reward_points": total_points(account),
		"official_opening_balance": official_opening,
		"work_date": str(getdate()),
		"currency": frappe.get_cached_value("Company", configuration.company, "default_currency")
		if configuration.company
		else "INR",
		"configured": bool(configuration.company),
		"account": account,
		"can_admin": is_admin(),
		"employee_name": profile.full_name or profile.name,
		"mobile": profile.get("mobile_no"),
		"sales_person": sales.name if sales else None,
		"territories": sorted(
			{
				row.territory
				for row in (
					frappe.get_list(
						"Customer",
						filters={**({"sales_person": sales.name} if sales else {}), "disabled": 0},
						fields=["territory"],
						distinct=True,
						limit_page_length=1000,
					)
					if frappe.has_permission("Customer", "read")
					else []
				)
				if row.territory
			}
		),
		"duties": duties,
		"current": current_summary,
		"company": configuration.company,
		"retention_policy": configuration.retention_policy,
		"vehicles": vehicles,
	}


def vehicle_employee(user):
	rows = frappe.get_all("Employee", filters={"user_id": user, "status": "Active"}, pluck="name", limit=2)
	return rows[0] if len(rows) == 1 else None


def vehicle_values(values):
	values = frappe.parse_json(values) if isinstance(values, str) else values
	if not isinstance(values, dict):
		frappe.throw("Complete vehicle details are required.")
	try:
		registration = indian_vehicle_number(values.get("registration_number"))
	except ValueError as exc:
		frappe.throw(str(exc))
	fuel = values.get("fuel_type")
	if fuel not in ("Petrol", "Diesel", "CNG"):
		frappe.throw("Select Petrol, Diesel or CNG.")
	result = {"registration_number": registration, "fuel_type": fuel}
	# Preserve legacy clients while the simple form submits explicit availability flags.
	for key, legacy in (
		("insurance", "insurance_number"),
		("puc", "puc_number"),
		("rc", "rc_number"),
		("fastag", "fastag_details"),
	):
		field = key + "_available"
		value = values.get(field, bool(values.get(legacy)))
		if value not in (True, False, 0, 1, "0", "1"):
			frappe.throw("Document availability must be ticked or unticked.")
		result[field] = int(str(value) in ("True", "1"))
	for field in ("insurance_expiry", "puc_expiry", "rc_expiry"):
		if field in values:
			result[field] = getdate(values[field]) if values[field] else None

	return result


def require_vehicle_documents(values):
	if not all(values.get(key + "_available") == 1 for key in ("insurance", "puc", "rc", "fastag")):
		frappe.throw("Tick Insurance, PUC, RC and FASTag before adding a vehicle.")


def vehicle_validation_error(vehicle):
	reasons = []
	for key, label in (("insurance", "Insurance"), ("puc", "PUC"), ("rc", "RC")):
		if not vehicle.get(key + "_available"):
			reasons.append(label + " is not available")
		expiry = vehicle.get(key + "_expiry")
		if expiry and getdate(expiry) < getdate():
			reasons.append(label + " is expired")
	return "; ".join(reasons)


def prepare_vehicle_allocation(account, vehicle=None):
	"""One current vehicle per salesperson; completed duty snapshots remain intact."""
	account_for(account, lock=True)
	if not {"Sales Person", "Sales Manager"}.intersection(frappe.get_roles(account)):
		frappe.throw("Allocate the vehicle to a Sales Person or Sales Manager.")
	if vehicle:
		frappe.db.get_value("DSR Vehicle", vehicle, "name", for_update=True)
	if vehicle and frappe.db.exists(
		"DSR Duty Session", {"vehicle_number": vehicle, "status": "Active", "account": ["!=", account]}
	):
		frappe.throw("This vehicle is in use on another salesperson's active duty.")
	for name in frappe.get_all(
		"DSR Vehicle",
		filters={"allocated_to": account, "name": ["!=", vehicle or ""]},
		pluck="name",
		limit_page_length=0,
	):
		previous = frappe.get_doc("DSR Vehicle", name, for_update=True)
		previous.allocated_to = None
		save(previous)


def available_vehicles():
	account = account_for()
	rows = frappe.get_all(
		"DSR Vehicle",
		filters={"status": "Active", "allocated_to": account},
		fields=[
			"name",
			"registration_number",
			"fuel_type",
			"insurance_available",
			"puc_available",
			"rc_available",
			"fastag_available",
			"insurance_expiry",
			"puc_expiry",
			"rc_expiry",
		],
		order_by="registration_number",
	)
	for row in rows:
		row.validation_error = vehicle_validation_error(row)
	return rows


@frappe.whitelist(methods=["POST"])
def add_vehicle(values):
	account = identity(True)
	values = frappe.parse_json(values) if isinstance(values, str) else values
	data = vehicle_values(values)
	require_vehicle_documents(data)
	status = values.get("status", "Active")
	if status not in ("Active", "Inactive"):
		frappe.throw("Select Active or Inactive status.")
	if frappe.db.exists("DSR Vehicle", {"registration_number": data["registration_number"]}):
		frappe.throw("This vehicle registration number already exists.")
	prepare_vehicle_allocation(account)
	doc = insert(
		"DSR Vehicle",
		**data,
		allocated_to=account,
		status=status,
		added_by=account,
		added_by_salesperson=vehicle_employee(account),
		created_date=now_datetime(),
	)
	return {"name": doc.name, "registration_number": doc.registration_number}


@frappe.whitelist(methods=["POST"])
def initialize_balance(user, opening_balance, request_key, remarks):
	require_finance()
	account = account_for(user)
	if not remarks:
		frappe.throw("An audit reason is required.")
	frappe.db.sql("select name from `tabUser` where name=%s for update", account)
	if repeated("DSR Cash Ledger", request_key, account):
		return repeated("DSR Cash Ledger", request_key, account).name
	if locked_exists("DSR Cash Ledger", {"account": account}) or frappe.db.exists(
		"DSR Duty Session", {"account": account}
	):
		frappe.throw("Cash is already initialized. Record an authorized adjustment instead.")
	value = float(money(opening_balance))
	return insert(
		"DSR Cash Ledger",
		account=account,
		transaction_type="Opening",
		amount=value,
		posting_time=now_datetime(),
		remarks=remarks,
		request_key=key(request_key, account),
	).name


@frappe.whitelist(methods=["POST"])
def odometer_camera_challenge(phase, reading, vehicle_number=None, request_key=None, duty=None):
	from .odometer import new_challenge

	return new_challenge(phase, reading, vehicle_number, request_key, duty)


@frappe.whitelist(methods=["POST"])
def duty_on(
	vehicle_number,
	fuel_type=None,
	start_location="Current Location",
	gps=None,
	request_key=None,
	documents=None,
	odometer_start=None,
	odometer_photo=None,
):
	account = identity(True)
	# Also verifies the enabled User account before any session is created.
	bootstrap()
	s = settings()
	if start_location not in ("Home", "Current Location"):
		frappe.throw("Select a supported starting location.")
	try:
		vehicle_number = indian_vehicle_number(vehicle_number)
	except ValueError as exc:
		frappe.throw(str(exc))
	vehicle = frappe.db.get_value(
		"DSR Vehicle",
		{"registration_number": vehicle_number},
		[
			"name",
			"fuel_type",
			"status",
			"allocated_to",
			"insurance_available",
			"puc_available",
			"rc_available",
			"fastag_available",
			"insurance_expiry",
			"puc_expiry",
			"rc_expiry",
		],
		as_dict=True,
		for_update=True,
	)
	if not vehicle:
		frappe.throw("Select a vehicle from Vehicle Management.")
	if vehicle.allocated_to != account:
		frappe.throw("This vehicle is not allocated to you.", frappe.PermissionError)
	if vehicle.status != "Active":
		frappe.throw("The selected vehicle is not active.")
	error = vehicle_validation_error(vehicle)
	if error:
		frappe.throw("The selected vehicle cannot start duty: " + error)
	fuel_type = vehicle.fuel_type
	confirmed = {
		"confirmed_" + key: int(bool(vehicle.get(key + "_available")))
		for key in ("insurance", "puc", "rc", "fastag")
	}
	point = location(gps)
	daily_key = (
		key("duty:" + request_key, account)
		if request_key
		else key("duty:" + frappe.generate_hash(length=20), account)
	)
	prior = frappe.db.get_value(
		"DSR Duty Session", {"daily_key": daily_key, "account": account}, "name", for_update=True
	)
	if prior:
		return summary(prior)
	active = frappe.db.get_value(
		"DSR Duty Session", {"account": account, "status": "Active"}, "name", for_update=True
	)
	if active:
		return summary(active)
	if locked_exists("DSR Duty Session", {"account": account, "status": "Closed"}):
		frappe.throw("Finalize the previous DSR before starting another duty.")
	previous = frappe.db.sql(
		"select name, closing_balance from `tabDSR Duty Session` where account=%s and status='Finalized' order by work_date desc, creation desc limit 1 for update",
		account,
		as_dict=True,
	)
	if previous:
		opening = previous[0].closing_balance
	else:
		opening = frappe.db.get_value(
			"DSR Cash Ledger",
			{"account": account, "transaction_type": "Opening", "duty": ["is", "not set"]},
			"amount",
			for_update=True,
		)
		if opening is None:
			frappe.throw("Administrator must initialize the official opening balance.")
	from .cash_allocations import next_opening

	opening = next_opening(account, previous[0] if previous else None, opening)
	if start_location == "Night Stay":
		stay = frappe.get_all(
			"DSR Night Stay",
			filters={"account": account},
			fields=["latitude", "longitude", "accuracy"],
			order_by="creation desc",
			limit=1,
		)
		if not stay or geofence(stay[0], point) != "Inside":
			frappe.throw("Starting location must be within the registered night stay.")
	from . import odometer

	start_reading = odometer.reading(odometer_start)
	photo = odometer.validate_photo(
		odometer_photo, odometer.context("start", account, start_reading, vehicle_number, request_key)
	)
	doc = insert(
		"DSR Duty Session",
		account=account,
		work_date=getdate(),
		daily_key=daily_key,
		odometer_start=start_reading,
		odometer_required=1,
		vehicle_number=vehicle_number.strip(),
		fuel_type=fuel_type,
		start_location=start_location,
		**confirmed,
		documents_confirmed_at=now_datetime(),
		documents_confirmed_by=frappe.session.user,
		started_at=now_datetime(),
		opening_balance=opening,
		closing_balance=opening,
		fuel_rate=s.get(fuel_type.lower() + "_rate"),
		gps_status="Tracking",
		last_sync=now_datetime(),
	)
	odometer.attach_photo(doc, "start", photo)
	save(doc)
	ledger(doc, "Opening", opening, doc.doctype, doc.name, "opening:" + doc.name)
	# The legacy DSR remains the daily reporting anchor, without legacy odometer calculations.
	report = frappe.get_doc(
		{
			"doctype": "DSR",
			"date": doc.work_date,
			"sales_person": bootstrap()["sales_person"],
			"smart_dsr": 1,
			"smart_duty": doc.name,
			"opening_balance": opening,
			"fuel_added": 0,
		}
	)
	report.flags.smart_dsr_write = True
	report.insert(
		ignore_permissions=True,
		ignore_mandatory=True,
		set_name=("SMART-DSR-" + doc.name) if not report.sales_person else None,
	)
	doc.dsr = report.name
	save(doc)
	point.update(id=request_key, captured_at=str(now_datetime()))
	gps_batch(doc.name, [point])
	event(
		doc,
		"Duty ON",
		"Duty started with approximate browser location; travel distance remains unverified."
		if point["accuracy"] > flt(s.max_accuracy_m)
		else "Duty started with accurate browser location.",
	)
	return summary(doc.name)


@frappe.whitelist(methods=["POST"])
def gps_interruption(duty, reason="Location unavailable"):
	doc = duty_doc(duty)
	identity(True)
	doc.flags.for_update = True
	doc.reload()
	if doc.status != "Active":
		stay = frappe.db.get_value(
			"DSR Night Stay", {"account": doc.account, "checked_out_at": ["is", "not set"]}, "name"
		)
		if not stay:
			frappe.throw("There is no authorized tracking session.")
		row = frappe.get_doc("DSR Night Stay", stay)
		if row.state != "Unknown":
			row.state = "Unknown"
			save(row)
			event(doc, "Geofence Unknown", str(reason)[:500])
		return {"status": "Unknown"}
	if doc.gps_status != "Interrupted":
		doc.gps_status = "Interrupted"
		doc.gps_interrupted_at = now_datetime()
		doc.manager_notified = 0
		event(doc, "Interrupted", str(reason)[:500])
		save(doc)
	return {"status": doc.gps_status}


@frappe.whitelist(methods=["POST"])
def gps_batch(duty, points):
	doc = duty_doc(duty)
	identity(True)
	doc.flags.for_update = True
	doc.reload()
	points = frappe.parse_json(points) if isinstance(points, str) else points
	stay_name = frappe.db.get_value(
		"DSR Night Stay", {"account": doc.account, "checked_out_at": ["is", "not set"]}, "name"
	)
	if doc.status != "Active" and not stay_name:
		frappe.throw("Tracking is permitted only during duty or an active night stay.")
	if not isinstance(points, list) or not points or len(points) > 200:
		frappe.throw("Send at most 200 GPS points per batch.")
	s = settings()
	max_accuracy = flt(s.max_accuracy_m)
	max_speed = flt(s.max_speed_kmh)
	max_gap = cint(s.max_gap_seconds)
	received_at = now_datetime()
	fresh_since = received_at - timedelta(seconds=max_gap)
	awaiting_recovery = doc.gps_status == "Interrupted"
	if awaiting_recovery and doc.gps_interrupted_at:
		fresh_since = max(fresh_since, get_datetime(doc.gps_interrupted_at))
	last = frappe.get_doc("DSR GPS Point", doc.last_point) if doc.last_point else None
	accepted = 0
	timed_points = [(capture_time(point["captured_at"]), point) for point in points]
	for timestamp, point in sorted(timed_points, key=lambda entry: entry[0]):
		lat, lon, accuracy = coordinates(point["latitude"], point["longitude"], point["accuracy"])
		if timestamp > received_at + timedelta(minutes=2) or timestamp < get_datetime(doc.started_at):
			frappe.throw("GPS timestamp lies outside this duty period.")
		if doc.ended_at and not stay_name and timestamp > get_datetime(doc.ended_at):
			frappe.throw("GPS timestamp lies after Duty OFF.")
		pk = key(point["id"], doc.account)
		if locked_exists("DSR GPS Point", {"point_key": pk}) or (
			doc.employee
			and locked_exists(
				"DSR GPS Point", {"point_key": key(point["id"], doc.employee), "account": doc.account}
			)
		):
			continue
		current = dict(latitude=lat, longitude=lon, accuracy=accuracy)
		seconds = (timestamp - get_datetime(last.captured_at)).total_seconds() if last else 0
		km, reason = segment(
			last.as_dict() if last else None,
			current,
			seconds,
			max_accuracy,
			max_speed,
			max_gap,
		)
		if awaiting_recovery and last:
			km, reason = 0, UNVERIFIED_INTERVAL

		estimate = km or estimated_segment(
			last.as_dict() if last else None, current, seconds, max_speed, max_gap
		)
		if doc.status != "Active":
			km = estimate = 0  # Night stay monitoring never accrues travel distance.
		row = insert(
			"DSR GPS Point",
			account=doc.account,
			duty=doc.name,
			point_key=pk,
			**current,
			captured_at=timestamp,
			received_at=received_at,
			verified=not bool(reason),
			rejection_reason=reason,
			distance_km=km,
			estimated_distance_km=estimate,
		)
		if last and km:
			insert(
				"DSR Travel Leg",
				account=doc.account,
				duty=doc.name,
				from_point=last.name,
				to_point=row.name,
				distance_km=km,
				duration_seconds=seconds,
			)
		if not last or seconds > 0:
			last = row
			doc.last_point = row.name
			# The first fresh fix closes the gap and anchors the next segment in this batch.
			if timestamp >= fresh_since and accuracy <= max_accuracy:
				awaiting_recovery = False
		if stay_name:
			stay = frappe.get_doc("DSR Night Stay", stay_name)
			if timestamp < get_datetime(stay.checked_in_at):
				accepted += 1
				continue
			state = geofence(stay.as_dict(), current, max_accuracy=flt(s.max_accuracy_m))
			if state != stay.state:
				event(doc, "Geofence " + state, stay.name)
				stay.state = state
				save(stay)
				if state == "Outside" and s.geofence_alerts:
					notify(doc, "Night stay: reliable reading outside 500 m — " + doc.account)
		accepted += 1
	# Only a fresh accurate point restores live tracking; uploading historical points does not.
	if (
		last
		and not awaiting_recovery
		and get_datetime(last.captured_at) >= fresh_since
		and last.accuracy <= max_accuracy
	):
		if doc.gps_status == "Interrupted":
			event(doc, "Resumed", "Location permission / signal restored; gap remains unverified.")
		doc.gps_status = "Tracking"
		doc.gps_interrupted_at = None
		doc.manager_notified = 0
	elif doc.status == "Active" and doc.gps_status != "Interrupted":
		doc.gps_status = "Interrupted"
		doc.gps_interrupted_at = received_at
		event(doc, "Interrupted", "No fresh location within the configured accuracy threshold.")
	doc.last_sync = received_at
	if doc.status == "Finalized":
		return {"accepted": accepted, "verified_km": doc.verified_km, "gps_status": "Night stay monitoring"}
	doc.verified_km = flt(
		frappe.db.sql(
			"select coalesce(sum(distance_km),0) from `tabDSR GPS Point` where duty=%s for update", doc.name
		)[0][0],
		4,
	)
	doc.fuel_reimbursement = fuel_entitlement(doc)
	doc.estimated_km = flt(
		doc.verified_km
		+ flt(
			frappe.db.sql(
				"select coalesce(sum(greatest(estimated_distance_km-distance_km,0)),0) from `tabDSR GPS Point` where duty=%s",
				doc.name,
			)[0][0]
		),
		4,
	)
	save(doc)
	return {
		"accepted": accepted,
		"verified_km": doc.verified_km,
		"estimated_km": doc.estimated_km,
		"gps_status": doc.gps_status,
		"fuel_reimbursement": doc.fuel_reimbursement,
		"location": dict(
			latitude=last.latitude,
			longitude=last.longitude,
			accuracy=last.accuracy,
			captured_at=public_dates(get_datetime(last.captured_at)),
		)
		if last
		else None,
	}


def check_tracking():
	"""Scheduled silence detection also works when Android or the browser stops reporting."""
	for name in frappe.get_all("DSR Duty Session", filters={"status": "Active"}, pluck="name"):
		doc = frappe.get_doc("DSR Duty Session", name)
		if not doc.account:
			continue
		frappe.db.sql("select name from `tabUser` where name=%s for update", doc.account)
		doc.flags.for_update = True
		doc.reload()
		if doc.status != "Active":
			continue
		s = settings()
		last = (
			frappe.db.get_value("DSR GPS Point", doc.last_point, "captured_at")
			if doc.last_point
			else doc.started_at
		)
		if (now_datetime() - get_datetime(last)).total_seconds() > cint(
			s.max_gap_seconds
		) and doc.gps_status != "Interrupted":
			doc.gps_status = "Interrupted"
			doc.gps_interrupted_at = now_datetime()
			event(doc, "Interrupted", "No fresh GPS sample received.")
		if (
			doc.gps_interrupted_at
			and not doc.manager_notified
			and (now_datetime() - get_datetime(doc.gps_interrupted_at)).total_seconds()
			>= cint(s.interruption_minutes) * 60
		):
			notify(doc, "GPS interruption requires attention — " + doc.account)
			doc.manager_notified = 1
		save(doc)


def check_night_tracking():
	for name in frappe.get_all("DSR Night Stay", filters={"checked_out_at": ["is", "not set"]}, pluck="name"):
		row = frappe.get_doc("DSR Night Stay", name)
		if not row.account:
			continue
		frappe.db.sql("select name from `tabUser` where name=%s for update", row.account)
		row.flags.for_update = True
		row.reload()
		if row.checked_out_at:
			continue
		latest = frappe.get_all(
			"DSR GPS Point",
			filters={"account": row.account, "captured_at": [">=", row.checked_in_at]},
			pluck="captured_at",
			order_by="captured_at desc",
			limit=1,
		)
		last = latest[0] if latest else row.checked_in_at
		if (now_datetime() - get_datetime(last)).total_seconds() > cint(
			settings().max_gap_seconds
		) and row.state != "Unknown":
			row.state = "Unknown"
			save(row)
			event(
				frappe.get_doc("DSR Duty Session", row.duty),
				"Geofence Unknown",
				"Night stay GPS samples unavailable; no violation assumed.",
			)


def dealer(customer):
	doc = frappe.get_doc("Customer", customer)
	doc.check_permission("read")
	sales = frappe.db.get_value("Sales Person", {"enabled": 1, "sales_user": identity()}, "name")
	if sales and doc.get("sales_person") != sales:
		frappe.throw("This dealer is not assigned to your Sales Person.", frappe.PermissionError)
	return doc


@frappe.whitelist()
def search_dealers(search="", territory=None):
	account = identity()
	sales = frappe.db.get_value("Sales Person", {"enabled": 1, "sales_user": account}, "name")
	filters = {"disabled": 0}
	if sales:
		filters["sales_person"] = sales
	if territory:
		filters["territory"] = territory
	return frappe.get_list(
		"Customer",
		filters=filters,
		or_filters={
			field: ["like", "%" + str(search)[:100] + "%"] for field in ("name", "customer_name", "mobile_no")
		},
		fields=["name", "customer_name", "mobile_no", "territory", "customer_primary_address"],
		order_by="customer_name asc, name asc",
		limit_page_length=0,
	)


@frappe.whitelist()
def allocated_dealer_overdues():
	"""Narrow dues summary for the signed-in salesperson's readable dealers."""
	account = identity()
	sales = frappe.db.get_value("Sales Person", {"enabled": 1, "sales_user": account}, "name")
	if not sales or not frappe.has_permission("Customer", "read"):
		return {"rows": [], "totals": {}, "sales_person": sales}
	customers = frappe.get_list(
		"Customer",
		filters={"sales_person": sales, "disabled": 0},
		fields=["name", "customer_name", "territory"],
		order_by="customer_name asc",
		limit_page_length=0,
	)
	if not customers:
		return {"rows": [], "totals": {}, "sales_person": sales}
	from srv_erp.overdues import company_name

	by_name = {row.name: row for row in customers}
	entries = frappe.get_all(
		"Dealer Overdue",
		filters={
			"customer": ["in", list(by_name)],
			"company": company_name(),
			"state": "Active",
			"entry_date": ["<=", getdate()],
			"outstanding_amount": [">", 0],
			"due_date": ["<", getdate()],
		},
		fields=[
			"customer",
			"currency",
			"sum(outstanding_amount) as overdue_amount",
			"count(name) as entry_count",
			"min(due_date) as oldest_due_date",
		],
		group_by="customer, currency",
		order_by="customer asc, currency asc",
		limit_page_length=0,
	)
	rows, totals = [], {}
	for entry in entries:
		customer = by_name[entry.customer]
		value = float(money(entry.overdue_amount))
		rows.append(
			{
				"customer": customer.name,
				"customer_name": customer.customer_name,
				"territory": customer.territory,
				"currency": entry.currency,
				"overdue_amount": value,
				"entry_count": entry.entry_count,
				"oldest_due_date": str(entry.oldest_due_date),
				"days_overdue": (getdate() - getdate(entry.oldest_due_date)).days,
			}
		)
		totals[entry.currency] = float(money(totals.get(entry.currency, 0) + value))
	rows.sort(key=lambda row: (row["customer_name"].lower(), row["currency"]))
	return {"rows": rows, "totals": totals, "sales_person": sales}


@frappe.whitelist()
def outstanding(customer):
	doc = dealer(customer)
	# Dealer access above is the authorization boundary for this narrow dues API.
	# Do not grant general accounting document access to field sales users.
	from srv_erp.overdues import company_name

	company = company_name()
	invoices = frappe.get_all(
		"Dealer Overdue",
		filters={
			"customer": customer,
			"company": company,
			"state": "Active",
			"entry_date": ["<=", getdate()],
			"outstanding_amount": [">", 0],
		},
		fields=["name", "entry_date as posting_date", "due_date", "outstanding_amount", "currency"],
		order_by="due_date asc, creation asc",
		limit_page_length=0,
	)
	for row in invoices:
		row.days_overdue = max(0, (getdate() - getdate(row.due_date)).days) if row.due_date else 0
	address = doc.customer_primary_address
	address_text = ""
	if address and frappe.db.exists(
		"Dynamic Link",
		{"parenttype": "Address", "parent": address, "link_doctype": "Customer", "link_name": customer},
	):
		parts = frappe.db.get_value(
			"Address", address, ["address_line1", "address_line2", "city", "state", "pincode"]
		)
		address_text = ", ".join(str(p) for p in parts if p) if parts else ""
	currency = frappe.get_cached_value("Company", company, "default_currency")
	# Never aggregate differing currencies into a misleading total.
	totals = {}
	for row in invoices:
		totals[row.currency] = totals.get(row.currency, 0) + flt(row.outstanding_amount)
	return {
		"dealer": {
			k: doc.get(k)
			for k in ("name", "customer_name", "mobile_no", "territory", "customer_primary_address")
		},
		"address": address_text,
		"invoices": invoices,
		"entries": invoices,
		"source": "manual",
		"totals_by_currency": totals,
		"pending": totals.get(currency, 0),
		"overdue": sum(
			flt(r.outstanding_amount) for r in invoices if r.days_overdue and r.currency == currency
		),
		"currency": currency,
		"oldest_due_date": next((r.due_date for r in invoices if r.days_overdue), None),
	}


@frappe.whitelist(methods=["POST"])
def dealer_arrival(duty, customer, gps=None, request_key=None):
	doc = active(duty)
	previous = repeated("DSR Dealer Activity", request_key, doc.account)
	if previous:
		return previous.name
	if locked_exists("DSR Dealer Activity", {"duty": duty, "status": "Open"}):
		frappe.throw("Complete the current dealer activity first.")
	dues = outstanding(customer)
	last_departure = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": "Completed"},
		pluck="departed_at",
		order_by="departed_at desc",
		limit=1,
	)
	since = last_departure[0] if last_departure else doc.started_at
	travel = frappe.db.sql(
		"select coalesce(sum(l.distance_km),0), coalesce(sum(l.duration_seconds),0) from `tabDSR Travel Leg` l inner join `tabDSR GPS Point` p on p.name=l.to_point where l.duty=%s and p.captured_at >= %s",
		(duty, since),
	)[0]
	activity = insert(
		"DSR Dealer Activity",
		account=doc.account,
		duty=duty,
		customer=customer,
		arrived_at=now_datetime(),
		**(location(gps) if gps is not None else {}),
		outstanding_reviewed=dues["pending"],
		travel_distance_km=travel[0],
		travel_duration_seconds=travel[1],
		request_key=key(request_key, doc.account),
	)
	prepare_visit_travel(activity, doc)
	if dues["overdue"]:
		event(doc, "Outstanding dues", f"{customer}: {dues['overdue']} overdue in {dues['currency']}")
	return activity.name


def require_visit_photo(row, account):
	if not valid_photo(row.name, account):
		frappe.throw("Upload a live shop photo before using visit services.")


def activity_doc(activity):
	row = frappe.get_doc("DSR Dealer Activity", activity)
	doc = active(row.duty)
	row.flags.for_update = True
	row.reload()
	if row.account != doc.account or row.status != "Open":
		frappe.throw("This dealer activity is not open.", frappe.PermissionError)
	return row, doc


@frappe.whitelist(methods=["POST"])
def delete_pending_visit(activity):
	"""Remove an owned pending visit from the workday, retaining its audit identity."""
	old = frappe.get_doc("DSR Dealer Activity", activity)
	doc = duty_doc(old.duty, True)
	if old.account != doc.account:
		frappe.throw("Visit access denied.", frappe.PermissionError)
	if old.status == "Deleted":
		return {"deleted": old.name}
	row, doc = activity_doc(activity)
	if locked_exists(
		"DSR Collection", {"activity": row.name, "verification_status": ["!=", "Reversed"]}
	) or locked_exists("Sales Order", {"custom_dsr_visit": row.name, "docstatus": ["!=", 2]}):
		frappe.throw(
			"This pending visit has linked payments or orders. Ask a Sales Manager to resolve them before deleting the visit."
		)
	for photo in frappe.get_all(
		"DSR Dealer Photo Evidence",
		filters={"activity": row.name, "account": doc.account, "photo": ["is", "set"]},
		pluck="name",
	):
		_remove_visit_photo(activity, photo)
	row.status = "Deleted"
	save(row)
	event(doc, "Exception", f"Pending visit {row.name} for {row.customer} deleted by {frappe.session.user}.")
	return {"deleted": row.name}


@frappe.whitelist(methods=["POST"])
def photo_challenge(activity, device):
	_row, doc = activity_doc(activity)
	dev = frappe.get_doc("DSR Mobile Device", device)
	if dev.account != doc.account or not dev.enabled:
		frappe.throw("An enrolled Android device is required.", frappe.PermissionError)
	token = secrets.token_urlsafe(32)
	frappe.cache().set_value(
		"dsr-photo:" + token,
		{"activity": activity, "account": doc.account, "device": device},
		expires_in_sec=120,
	)
	return {"challenge": token, "expires_in": 120}


@frappe.whitelist(methods=["POST"])
def submit_photo(activity, device, challenge, captured_at, gps, image_base64, signature):
	"""Verify a device key signature over a short-lived server challenge and exact evidence.

	Enrollment is performed by Administrator; this is a trust boundary, not hardware attestation.
	"""
	from cryptography.hazmat.primitives import hashes, serialization
	from cryptography.hazmat.primitives.asymmetric import ec
	from PIL import Image

	row, doc = activity_doc(activity)
	known = frappe.cache().get_value("dsr-photo:" + challenge)
	if not known or known != {"activity": activity, "account": doc.account, "device": device}:
		frappe.throw("Photo challenge expired or invalid.")
	dev = frappe.get_doc("DSR Mobile Device", device)
	if dev.account != doc.account or not dev.enabled:
		frappe.throw("Device is not enrolled.", frappe.PermissionError)
	if len(image_base64) > 7_000_000:
		frappe.throw("Photo exceeds 5 MB.")
	try:
		data = base64.b64decode(image_base64, validate=True)
		if len(data) > 5_000_000:
			raise ValueError("Too large")
		with Image.open(io.BytesIO(data)) as photo:
			if photo.format != "JPEG" or photo.width * photo.height > 24_000_000:
				raise ValueError("Invalid JPEG dimensions")
			photo.verify()
		point = location(gps, require_precise=True)
		digest = hashlib.sha256(data).hexdigest()
		stamp = capture_time(captured_at)
		if abs((now_datetime() - stamp).total_seconds()) > 120:
			raise ValueError("Capture time expired")
		# Canonical signed payload is deliberately simple and shared with Android.
		message = "\n".join(
			(
				challenge,
				activity,
				captured_at,
				f"{point['latitude']:.8f}",
				f"{point['longitude']:.8f}",
				f"{point['accuracy']:.3f}",
				digest,
			)
		)
		public_key = serialization.load_pem_public_key(dev.public_key.encode())
		public_key.verify(
			base64.b64decode(signature, validate=True), message.encode(), ec.ECDSA(hashes.SHA256())
		)
	except Exception:
		frappe.throw("Photo evidence failed validation. Capture a new shop photo on the enrolled device.")
	from frappe.utils.file_manager import save_file

	evidence = insert(
		"DSR Dealer Photo Evidence",
		account=doc.account,
		duty=doc.name,
		activity=activity,
		**point,
		captured_at=stamp,
		received_at=now_datetime(),
		sha256=digest,
		capture_source="Enrolled Android camera",
		challenge=challenge,
	)
	previous_evidence_flag = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		file = save_file(
			"shop-" + evidence.name + ".jpg", data, evidence.doctype, evidence.name, is_private=1
		)
	finally:
		frappe.flags.smart_dsr_evidence_write = previous_evidence_flag
	evidence.photo = file.file_url
	save(evidence)
	from .rewards import start_timer

	start_timer(row, evidence)
	frappe.cache().delete_value("dsr-photo:" + challenge)
	return {"name": evidence.name, "photo": evidence.photo}


def _remove_visit_photo(activity, photo):
	"""Remove an owned open visit's attachment while keeping capture audit metadata."""
	row, doc = activity_doc(activity)
	evidence = frappe.get_doc("DSR Dealer Photo Evidence", photo, for_update=True)
	if evidence.activity != row.name or evidence.duty != doc.name or evidence.account != doc.account:
		frappe.throw("Photo access denied.", frappe.PermissionError)
	if not evidence.photo:
		return {"deleted": evidence.name}
	files = frappe.get_all(
		"File",
		filters={
			"attached_to_doctype": evidence.doctype,
			"attached_to_name": evidence.name,
			"file_url": evidence.photo,
		},
		pluck="name",
	)
	evidence.photo = None
	save(evidence)
	event(
		doc,
		"Exception",
		f"Visit {row.name}: photo {evidence.name} deleted by {frappe.session.user} for retake.",
	)
	previous_flag = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		for name in files:
			frappe.delete_doc("File", name, ignore_permissions=True)
	finally:
		frappe.flags.smart_dsr_evidence_write = previous_flag
	return {"deleted": evidence.name}


@frappe.whitelist(methods=["POST"])
def retake_visit_photo(activity):
	"""A confirmed retake removes the current image before issuing a new camera challenge."""
	row, doc = activity_doc(activity)
	photos = frappe.get_all(
		"DSR Dealer Photo Evidence",
		filters={"activity": row.name, "account": doc.account, "photo": ["is", "set"]},
		pluck="name",
	)
	for photo in photos:
		_remove_visit_photo(activity, photo)
	return browser_photo_challenge(activity)


def valid_photo(activity, account):
	for evidence in frappe.get_all(
		"DSR Dealer Photo Evidence",
		filters={"activity": activity, "account": account},
		fields=["name", "photo", "sha256"],
	):
		file = (
			frappe.db.get_value(
				"File",
				{
					"file_url": evidence.photo,
					"is_private": 1,
					"attached_to_doctype": "DSR Dealer Photo Evidence",
					"attached_to_name": evidence.name,
				},
				"name",
			)
			if evidence.photo
			else None
		)
		if file:
			try:
				content = frappe.get_doc("File", file).get_content()
				if hashlib.sha256(content).hexdigest() == evidence.sha256:
					return True
			except (OSError, frappe.DoesNotExistError):
				continue
	return False


@frappe.whitelist(methods=["POST"])
def complete_activity(activity, gps, remarks=""):
	old = frappe.get_doc("DSR Dealer Activity", activity)
	owner = duty_doc(old.duty, True)
	if old.account != owner.account:
		frappe.throw("Visit access denied.", frappe.PermissionError)
	if old.status == "Completed":
		return old.name
	row, doc = activity_doc(activity)
	if frappe.db.exists(
		"DSR Dealer Photo Evidence",
		{
			"activity": row.name,
			"account": doc.account,
			"photo": ["is", "set"],
			"capture_source": "Browser camera pending location",
		},
	):
		frappe.throw("Wait for the shop photo location, or retry location before submitting.")
	if not row.photo_exception and not valid_photo(activity, doc.account):
		frappe.throw("Capture a verified live shop photo before completing this activity.")
	point = location(gps)
	row.departed_at = now_datetime()
	row.activity_duration_minutes = (row.departed_at - get_datetime(row.arrived_at)).total_seconds() / 60
	row.departure_latitude, row.departure_longitude = point["latitude"], point["longitude"]
	from .rewards import finalize_reward

	s = settings()
	finalize_reward(row, row.departed_at, point, cint(s.max_gap_seconds), flt(s.max_accuracy_m))
	row.remarks, row.status = str(remarks)[:4000], "Completed"
	save(row)
	recalculate(doc)
	save(doc)
	return row.name


@frappe.whitelist(methods=["POST"])
def authorize_exception(duty, reason, activity=None):
	if frappe.session.user != "Administrator":
		frappe.throw("Only Administrator can authorize an evidence exception.", frappe.PermissionError)
	if not str(reason).strip():
		frappe.throw("An audit reason is required.")
	doc = frappe.get_doc("DSR Duty Session", duty)
	frappe.db.sql("select name from `tabUser` where name=%s for update", doc.account)
	doc.flags.for_update = True
	doc.reload()
	if doc.status == "Finalized":
		frappe.throw("Finalized evidence cannot be changed.")
	if activity:
		row = frappe.get_doc("DSR Dealer Activity", activity)
		if row.duty != duty:
			frappe.throw("Activity is not associated with this duty.")
		row.photo_exception = reason
		save(row)
	else:
		doc.gps_exception = reason
		save(doc)
	event(doc, "Exception", reason)


@frappe.whitelist(methods=["POST"])
def collect_payment(
	duty, customer, value, payment_method, request_key, allocations=None, transaction_reference="", remarks=""
):
	doc = active(duty)
	return collect_payment_document(
		doc, customer, value, payment_method, request_key, allocations, transaction_reference, remarks
	)


def collect_payment_document(
	doc,
	customer,
	value,
	payment_method,
	request_key,
	allocations=None,
	transaction_reference="",
	remarks="",
	validate_customer=True,
):
	duty = doc.name
	if doc.status == "Finalized":
		frappe.throw("Finalized DSRs are immutable.")
	prior = repeated("DSR Collection", request_key, doc.account)
	if prior:
		from srv_erp.overdues import sync_collection_receipt

		sync_collection_receipt(prior)
		return {"name": prior.name, "balance": cash_balance(doc)}
	if validate_customer:
		dealer(customer)
	elif not frappe.db.exists("Customer", customer):
		frappe.throw("Select an existing Customer.")
	frappe.db.sql("select name from `tabCustomer` where name=%s for update", customer)
	value = amount(value)
	if payment_method not in ("Cash", "UPI", "Bank Transfer", "Cheque"):
		frappe.throw("Invalid payment method.")
	if payment_method != "Cash" and not transaction_reference:
		frappe.throw("Transaction reference is required for noncash payments.")
	allocations = (
		frappe.parse_json(allocations or "[]")
		if isinstance(allocations, str) or allocations is None
		else allocations
	)
	if not isinstance(allocations, list) or len(allocations) > 100:
		frappe.throw("Invalid invoice allocations.")
	seen = set()
	for allocation in sorted(allocations, key=lambda x: x["invoice"]):
		name = allocation["invoice"]
		if name in seen:
			frappe.throw("An invoice may only appear once.")
		seen.add(name)
		frappe.db.sql("select name from `tabSales Invoice` where name=%s for update", name)
		invoice = frappe.get_doc("Sales Invoice", name, for_update=True)
		if invoice.customer != customer or invoice.company != settings().company or invoice.docstatus != 1:
			frappe.throw("Invoice does not belong to this dealer and company.")
		if invoice.currency != frappe.get_cached_value("Company", settings().company, "default_currency"):
			frappe.throw("Foreign currency collection requires the accounts workflow.")
		allocation["amount"] = amount(allocation["amount"])
		# Reserve unposted collections as well, to avoid allocating the same dues twice.
		reserved = 0
		for pending_row in frappe.db.sql(
			"select allocations from `tabDSR Collection` where customer=%s and verification_status='Recorded' for update",
			customer,
		):
			pending = pending_row[0]
			reserved += sum(flt(a["amount"]) for a in json.loads(pending or "[]") if a["invoice"] == name)
		if money(allocation["amount"]) > money(flt(invoice.outstanding_amount) - reserved):
			frappe.throw("Allocation exceeds available outstanding amount.")
	if money(sum(a["amount"] for a in allocations)) > money(value):
		frappe.throw("Invoice allocations exceed the collection.")
	row = insert(
		"DSR Collection",
		account=doc.account,
		duty=duty,
		customer=customer,
		amount=value,
		payment_method=payment_method,
		transaction_reference=transaction_reference,
		remarks=remarks,
		collected_at=now_datetime(),
		allocations=json.dumps(allocations),
		request_key=key(request_key, doc.account),
	)
	from srv_erp.overdues import sync_collection_receipt

	sync_collection_receipt(row)
	kind = {
		"Cash": "Dealer Cash Collection",
		"UPI": "Dealer Digital Collection",
		"Bank Transfer": "Dealer Digital Collection",
		"Cheque": "Dealer Cheque Collection",
	}[payment_method]
	ledger(doc, kind, value, row.doctype, row.name, "collection:" + row.name)
	event(doc, "Payment collected", f"{customer}: {value} via {payment_method}; collection {row.name}")
	return {"name": row.name, "balance": cash_balance(doc)}


@frappe.whitelist(methods=["POST"])
def post_collection(collection):
	"""Accounts posts once through ERPNext; recording physical custody never posts GL twice."""
	require_finance()
	row = frappe.get_doc("DSR Collection", collection)
	frappe.db.sql("select name from `tabUser` where name=%s for update", row.account)
	row.flags.for_update = True
	row.reload()
	frappe.db.sql("select name from `tabCustomer` where name=%s for update", row.customer)
	if row.verification_status == "Reversed":
		frappe.throw("A reversed collection cannot be posted.")
	if row.payment_entry:
		return row.payment_entry
	from erpnext.accounts.party import get_party_account

	s = settings()
	account = s.cash_account if row.payment_method == "Cash" else s.bank_account
	if not account:
		frappe.throw("Configure the collection cash / bank account in DSR Settings.")
	currency = frappe.get_cached_value("Company", s.company, "default_currency")
	party_account = get_party_account("Customer", row.customer, s.company)
	for account_name in (account, party_account):
		if frappe.get_cached_value("Account", account_name, "account_currency") != currency:
			frappe.throw("Foreign currency posting requires the accounts workflow.")
	pe = frappe.get_doc(
		{
			"doctype": "Payment Entry",
			"payment_type": "Receive",
			"company": s.company,
			"party_type": "Customer",
			"party": row.customer,
			"posting_date": getdate(row.collected_at),
			"paid_from": party_account,
			"paid_to": account,
			"paid_amount": row.amount,
			"received_amount": row.amount,
			"source_exchange_rate": 1,
			"target_exchange_rate": 1,
			"reference_no": row.transaction_reference or row.name,
			"reference_date": getdate(row.collected_at),
			"remarks": "Smart DSR collection " + row.name,
		}
	)
	for allocation in json.loads(row.allocations or "[]"):
		pe.append(
			"references",
			{
				"reference_doctype": "Sales Invoice",
				"reference_name": allocation["invoice"],
				"allocated_amount": allocation["amount"],
			},
		)
	pe.set_missing_values()
	pe.insert()
	pe.submit()
	row.payment_entry, row.verification_status = pe.name, "Posted"
	save(row)
	return pe.name


@frappe.whitelist(methods=["POST"])
def record_expense(
	duty, category, value, paid_from_cash, request_key, remarks="", receipt=None, receipt_file=None
):
	doc = active(duty)
	if category not in ("Fuel (CNG/Petrol/Diesel)", "Other Expense"):
		frappe.throw("Select Fuel (CNG/Petrol/Diesel) or Other Expense.")
	if category in ("Breakfast", "Lunch", "Dinner", "Night Stay") or (
		isinstance(request_key, str) and request_key.startswith(("automatic-meal:", "automatic-night-stay:"))
	):
		frappe.throw("Meal and night stay expenses are added automatically.", frappe.PermissionError)
	prior = repeated("DSR Expense Record", request_key, doc.account)
	if prior:
		return {"name": prior.name, "balance": cash_balance(doc)}
	if receipt:
		frappe.throw("Capture the receipt using the live receipt camera.", frappe.PermissionError)
	if not receipt_file:
		frappe.throw("A receipt is required for every expense.")
	if category == "Other Expense" and not str(remarks or "").strip():
		frappe.throw("Remarks are required for other expenses.")
	attachment = expense_receipt(receipt_file, doc, request_key) if receipt_file else None
	result = record_expense_document(doc, category, value, 0, request_key, remarks, receipt)
	if attachment:
		from frappe.utils.file_manager import save_file

		row = frappe.get_doc("DSR Expense Record", result["name"])
		file = save_file(attachment[0], attachment[1], row.doctype, row.name, is_private=1, df="receipt")
		row.receipt = file.file_url
		save(row)
		payload = frappe.parse_json(receipt_file) if isinstance(receipt_file, str) else receipt_file
		frappe.cache().delete_value("dsr-receipt:" + payload["challenge"])
	return result


@frappe.whitelist(methods=["POST"])
def receipt_camera_challenge(duty, request_key):
	doc = active(duty)
	key(request_key, doc.account)
	token = secrets.token_urlsafe(32)
	frappe.cache().set_value(
		"dsr-receipt:" + token,
		{"duty": doc.name, "account": doc.account, "request_key": request_key},
		expires_in_sec=120,
	)
	return token


def expense_receipt(value, doc, request_key):
	"""Accept a fresh JPEG camera capture bound to this owner, duty, and expense."""
	from PIL import Image

	value = frappe.parse_json(value) if isinstance(value, str) else value
	if not isinstance(value, dict):
		frappe.throw("Capture a receipt using the live camera.")
	challenge = value.get("challenge")
	if not isinstance(challenge, str) or len(challenge) > 128:
		frappe.throw("Open the receipt camera and capture a new receipt.")
	known = frappe.cache().get_value("dsr-receipt:" + challenge)
	if known != {"duty": doc.name, "account": doc.account, "request_key": request_key}:
		frappe.throw("Receipt camera session expired. Retake the receipt and save again.")
	encoded = value.get("content")
	if not isinstance(encoded, str) or len(encoded) > 7_000_000:
		frappe.throw("Capture a receipt photo up to 5 MB.")
	try:
		data = base64.b64decode(encoded, validate=True)
		if not data or len(data) > 5_000_000:
			raise ValueError()
		with Image.open(io.BytesIO(data)) as image:
			if image.format != "JPEG" or not 10000 <= image.width * image.height <= 24_000_000:
				raise ValueError()
			image.verify()
	except Exception:
		frappe.throw("Capture a valid receipt photo using the live camera.")
	return "receipt.jpg", data


@frappe.whitelist(methods=["POST"])
def refresh_expenses(duty):
	"""Refresh the owner's balances and catch up scheduled meals without client-supplied times."""
	doc = duty_doc(duty, True)
	from .meal_expenses import post_due_meals

	post_due_meals(doc)
	return summary(doc.name)


def record_expense_document(
	doc, category, value, paid_from_cash, request_key, remarks="", receipt=None, receipt_owner=None
):
	duty = doc.name
	if doc.status == "Finalized" or doc.get("no_visit_duty"):
		frappe.throw("Finalized or no-visit DSR expenses are immutable.")
	prior = repeated("DSR Expense Record", request_key, doc.account)
	if prior:
		return {"name": prior.name, "balance": cash_balance(doc)}
	if category not in (
		"Fuel (CNG/Petrol/Diesel)",
		"Other Expense",
		"Fuel Reimbursement",
		"Breakfast",
		"Lunch",
		"Dinner",
		"Night Stay",
	):
		frappe.throw("Invalid expense category.")
	value = amount(value)
	if category == "Fuel Reimbursement":
		if not cint(paid_from_cash):
			frappe.throw(
				"Fuel entitlement is already calculated. Record a fuel disbursement only when it actually uses tracked cash."
			)
		disbursed = sum(
			flt(row[0])
			for row in frappe.db.sql(
				"select amount from `tabDSR Expense Record` where duty=%s and category='Fuel Reimbursement' and coalesce(posting_status,'Recorded') != 'Reversed' for update",
				duty,
			)
		)
		eligible = money(fuel_entitlement(doc))
		if money(disbursed + value) > eligible:
			frappe.throw("Fuel cash disbursements cannot exceed the verified GPS reimbursement entitlement.")

	if receipt:
		file = frappe.get_doc("File", {"file_url": receipt})
		if not file.is_private or file.owner != (receipt_owner or frappe.session.user):
			frappe.throw("Use your own private receipt.", frappe.PermissionError)
	row = insert(
		"DSR Expense Record",
		account=doc.account,
		duty=duty,
		category=category,
		amount=amount(value),
		paid_from_cash=bool(cint(paid_from_cash)),
		recorded_at=now_datetime(),
		remarks=remarks,
		receipt=receipt,
		request_key=key(request_key, doc.account),
	)
	if category == "Night Stay" and cint(paid_from_cash):
		ledger(doc, "Cash Expense", -row.amount, row.doctype, row.name, "expense:" + row.name)
	return {"name": row.name, "balance": cash_balance(doc)}


@frappe.whitelist(methods=["POST"])
def start_break(duty, break_type, request_key):
	doc = active(duty)
	prior = repeated("DSR Break", request_key, doc.account)
	if prior:
		return prior.name
	if break_type not in ("Breakfast", "Lunch", "Dinner", "Tea"):
		frappe.throw("Invalid break type.")
	if locked_exists("DSR Break", {"duty": duty, "ended_at": ["is", "not set"]}):
		frappe.throw("End the current break first.")
	return insert(
		"DSR Break",
		account=doc.account,
		duty=duty,
		break_type=break_type,
		started_at=now_datetime(),
		request_key=key(request_key, doc.account),
	).name


@frappe.whitelist(methods=["POST"])
def end_break(break_id):
	row = frappe.get_doc("DSR Break", break_id)
	doc = active(row.duty)
	row.flags.for_update = True
	row.reload()
	if row.account != doc.account:
		frappe.throw("Unauthorized break.", frappe.PermissionError)
	if row.ended_at:
		return row.as_dict()
	row.ended_at = now_datetime()
	row.duration_minutes = (row.ended_at - get_datetime(row.started_at)).total_seconds() / 60
	s = settings()
	kind = row.break_type.lower()
	from .meal_expenses import automatic_meals_enabled

	if (
		not automatic_meals_enabled(doc)
		and kind != "tea"
		and row.duration_minutes >= cint(s.meal_min_minutes)
		and cint(s.get(kind + "_start")) <= get_datetime(row.started_at).hour < cint(s.get(kind + "_end"))
	):
		meal_key = key("meal:" + str(doc.work_date) + ":" + kind, doc.account)
		if not locked_exists("DSR Break", {"meal_key": meal_key}) and not (
			doc.employee
			and locked_exists(
				"DSR Break",
				{"meal_key": doc.employee + ":" + str(doc.work_date) + ":" + kind, "account": doc.account},
			)
		):
			row.meal_key, row.allowance = meal_key, s.get(kind + "_amount")
	save(row)
	return row.as_dict()


@frappe.whitelist(methods=["POST"])
def night_stay_on(duty, gps, address="", request_key=None):
	from .night_stay import turn_on

	return turn_on(duty, gps, address, request_key)


@frappe.whitelist(methods=["POST"])
def night_stay_off(stay, gps=None):
	from .night_stay import turn_off

	return turn_off(stay, gps)


@frappe.whitelist(methods=["POST"])
def duty_off_readiness(duty):
	"""Let the owner's browser leave Duty OFF before collecting unnecessary evidence."""
	doc = duty_doc(duty)
	if doc.status != "Active":
		return {"ready": False, "tasks": [], "message": "This duty has already ended."}
	if frappe.db.exists(
		"DSR Night Stay", {"duty": duty, "account": doc.account, "checked_out_at": ["is", "not set"]}
	):
		return {
			"ready": False,
			"tasks": [{"type": "night_stay"}],
			"message": "Switch Night Stay OFF before Duty OFF.",
		}
	from .night_stay import duty_off_wait

	wait = duty_off_wait(doc)
	if wait["remaining_seconds"]:
		return {"ready": False, "tasks": [{"type": "night_stay_wait", **wait}], "message": wait["message"]}
	visits = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": "Open"},
		fields=["name", "customer"],
		limit_page_length=0,
	)
	breaks = frappe.get_all(
		"DSR Break",
		filters={"duty": duty, "ended_at": ["is", "not set"]},
		fields=["name", "break_type"],
		limit_page_length=0,
	)
	tasks = [{"type": "visit", "name": row.name, "customer": row.customer} for row in visits] + [
		{"type": "break", "name": row.name, "break_type": row.break_type} for row in breaks
	]
	if tasks:
		message = (
			"Complete pending party visits and end the active break before Duty OFF."
			if visits and breaks
			else "Complete pending party visits before Duty OFF."
			if visits
			else "End the active break before Duty OFF."
		)
		return {"ready": False, "tasks": tasks, "message": message}
	completed_visits = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": "Completed"},
		fields=["name", "photo_exception"],
		limit_page_length=0,
	)
	for row in completed_visits:
		if not row.photo_exception and not valid_photo(row.name, doc.account):
			tasks.append({"type": "evidence", "name": row.name})
	return {
		"ready": not tasks,
		"tasks": tasks,
		"requires_no_visit_reason": not bool(completed_visits),
		"message": "Some visit photos are missing or changed. Ask an Administrator to resolve them before Duty OFF."
		if tasks
		else "",
	}


@frappe.whitelist(methods=["POST"])
def duty_off(duty, gps=None, odometer_end=None, odometer_photo=None, duty_off_reason=None):
	doc = duty_doc(duty, True)
	if doc.status == "Closed":
		return summary(duty)
	if locked_exists(
		"DSR Night Stay", {"duty": duty, "account": doc.account, "checked_out_at": ["is", "not set"]}
	):
		frappe.throw("Switch Night Stay OFF before Duty OFF.")
	from .night_stay import duty_off_wait

	wait = duty_off_wait(doc)
	if wait["remaining_seconds"]:
		frappe.throw(wait["message"])
	if locked_exists("DSR Dealer Activity", {"duty": duty, "status": "Open"}):
		frappe.throw("Complete all dealer activities before Duty OFF.")
	if locked_exists("DSR Break", {"duty": duty, "ended_at": ["is", "not set"]}):
		frappe.throw("End the active break before Duty OFF.")
	no_visits = not locked_exists("DSR Dealer Activity", {"duty": duty, "status": "Completed"})
	if no_visits:
		from .no_visit_duty import validate_reason

		duty_off_reason = validate_reason(duty_off_reason)
	if gps:
		point = location(gps)
		point.update(id="off:" + secrets.token_hex(12), captured_at=str(now_datetime()))
		gps_batch(duty, [point])
		doc.flags.for_update = True
		doc.reload()
	elif not doc.gps_exception:
		frappe.throw("Ending GPS is required, or ask Administrator to authorize an exception.")
	from . import odometer

	if doc.get("odometer_required") or odometer_end is not None or odometer_photo:
		end_reading = odometer.reading(odometer_end)
		if doc.get("odometer_start_photo"):
			odometer.validate_stored_photo(doc, "start")
			doc.odometer_distance = odometer.difference(doc.odometer_start, end_reading)
		elif doc.get("odometer_required"):
			frappe.throw("Starting meter evidence is missing. Contact an Administrator.")
		photo = odometer.validate_photo(
			odometer_photo,
			odometer.context("end", doc.account, end_reading, doc.vehicle_number, duty=doc.name),
		)
		doc.odometer_end = end_reading
		odometer.attach_photo(doc, "end", photo)
	from .meal_expenses import post_due_meals

	if no_visits:
		doc.no_visit_duty = 1
		doc.duty_off_reason = duty_off_reason
		from .no_visit_duty import reverse_benefits

		reverse_benefits(doc)
	else:
		post_due_meals(doc)
	doc.ended_at, doc.status, doc.gps_status = now_datetime(), "Closed", "Stopped"
	recalculate(doc)
	save(doc)
	event(doc, "Duty OFF", "Duty ended; cash and eligible reimbursements recalculated.")
	return summary(duty)


def recalculate(doc):
	doc.verified_km = flt(
		frappe.db.sql(
			"select coalesce(sum(distance_km),0) from `tabDSR GPS Point` where duty=%s for update", doc.name
		)[0][0],
		4,
	)
	doc.fuel_reimbursement = fuel_entitlement(doc)
	from .meal_expenses import legacy_allowance

	doc.meal_allowance = legacy_allowance(doc)

	doc.closing_balance = cash_balance(doc)


@frappe.whitelist(methods=["POST"])
def finalize(duty):
	doc = duty_doc(duty)
	if doc.status == "Finalized":
		return summary(duty)
	doc = duty_doc(duty, True)
	finalize_document(doc)
	return summary(duty)


def finalize_document(doc):
	duty = doc.name
	if doc.status == "Finalized":
		return doc
	if doc.status != "Closed":
		frappe.throw("Complete Duty OFF before submitting your DSR.")
	if doc.get("odometer_required"):
		from .odometer import difference, validate_stored_photo

		validate_stored_photo(doc, "start")
		validate_stored_photo(doc, "end")
		doc.odometer_distance = difference(doc.odometer_start, doc.odometer_end)
	for activity in frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": ["!=", "Deleted"]},
		fields=["name", "photo_exception"],
	):
		if not activity.photo_exception and not valid_photo(activity.name, doc.account):
			frappe.throw(
				"Dealer evidence is missing or changed. Ask Administrator to review the exception before finalizing."
			)
	recalculate(doc)
	doc.status = "Finalized"
	save(doc)
	report = frappe.get_doc("DSR", doc.dsr)
	report.flags.smart_dsr_write = True
	report.flags.ignore_permissions = True
	report.flags.ignore_mandatory = True
	report.submit()
	event(doc, "Finalized", "Server recalculated and finalized cash and reimbursements.")
	return doc


@frappe.whitelist(methods=["POST"])
def cash_movement(duty, transaction_type, value, request_key, remarks, reversal_of=None):
	require_finance()
	doc = frappe.get_doc("DSR Duty Session", duty)
	frappe.db.sql("select name from `tabUser` where name=%s for update", doc.account)
	doc.flags.for_update = True
	doc.reload()
	if doc.status == "Finalized":
		frappe.throw("Record corrections in the next open DSR; finalized balances are immutable.")
	prior = repeated("DSR Cash Ledger", request_key, doc.account)
	if prior:
		return prior.name
	if not remarks:
		frappe.throw("An audit reason is required.")
	if transaction_type == "Reversal":
		original = frappe.get_doc("DSR Cash Ledger", reversal_of)
		if original.duty != duty or original.transaction_type in ("Opening", "Reversal"):
			frappe.throw("Invalid reversal source.")
		if frappe.db.exists(
			"DSR Cash Ledger",
			{"source_type": original.doctype, "source_name": original.name, "transaction_type": "Reversal"},
		):
			frappe.throw("This movement is already reversed.")
		if original.source_type == "DSR Collection":
			collection = frappe.get_doc("DSR Collection", original.source_name)
			if (
				collection.payment_entry
				and frappe.db.get_value("Payment Entry", collection.payment_entry, "docstatus") != 2
			):
				frappe.throw("Cancel and reconcile the ERPNext payment through Accounts first.")
			from srv_erp.overdues import reverse_collection_receipt

			reverse_collection_receipt(collection)
			collection.verification_status = "Reversed"
			save(collection)
		elif original.source_type == "DSR Expense Record":
			expense = frappe.get_doc("DSR Expense Record", original.source_name)
			expense.posting_status = "Reversed"
			save(expense)
		value = -flt(original.amount)
	elif transaction_type in ("Cash Advance", "Cash Handover"):
		value = amount(value) * (-1 if transaction_type == "Cash Handover" else 1)
	elif transaction_type == "Authorized Adjustment":
		value = float(money(value))
	else:
		frappe.throw("Unsupported cash movement.")
	return ledger(
		doc,
		transaction_type,
		value,
		"DSR Cash Ledger" if reversal_of else doc.doctype,
		reversal_of or duty,
		request_key,
		remarks,
	).name


def readable_orders(**kwargs):
	# A User can use their DSR without gaining ERPNext Sales Order permissions.
	if not frappe.has_permission("Sales Order", "read"):
		return []
	return frappe.get_list("Sales Order", **kwargs)


def closed_gap_seconds(duty):
	"""Do not count time spent OFF when a closed draft is explicitly reopened."""
	if not frappe.db.exists("DocType", "DSR Admin Audit"):
		return 0
	seconds = 0
	for entry in frappe.get_all(
		"DSR Admin Audit",
		filters={
			"record_type": "DSR Duty Session",
			"record_id": duty,
			"action": "reopen",
			"outcome": "Applied",
		},
		fields=["original_value", "recorded_at"],
		limit_page_length=0,
	):
		previous = frappe.parse_json(entry.original_value or "{}")
		if previous.get("ended_at"):
			seconds += max(
				0, (get_datetime(entry.recorded_at) - get_datetime(previous["ended_at"])).total_seconds()
			)
	return seconds


def fuel_entitlement(doc):
	return 0.0 if doc.get("no_visit_duty") else float(money(flt(doc.verified_km) * flt(doc.fuel_rate)))


def duty_seconds(doc):
	if doc.get("no_visit_duty"):
		return 0
	end = get_datetime(doc.ended_at) if doc.ended_at else now_datetime()
	return max(0, (end - get_datetime(doc.started_at)).total_seconds() - closed_gap_seconds(doc.name))


@frappe.whitelist()
def summary(duty):
	doc = duty_doc(duty)

	def rows(dt, fields):
		where = {"duty": duty}
		if dt == "DSR Dealer Activity":
			where["status"] = ["!=", "Deleted"]
		if dt == "DSR Dealer Photo Evidence":
			where["photo"] = ["is", "set"]
		return frappe.get_all(
			dt, filters=where, fields=fields, order_by="creation asc,name asc", limit_page_length=0
		)

	collections = rows(
		"DSR Collection",
		[
			"name",
			"customer",
			"amount",
			"payment_method",
			"collected_at",
			"verification_status",
			"allocations",
			"payment_entry",
		],
	)
	expenses = rows(
		"DSR Expense Record",
		[
			"name",
			"category",
			"amount",
			"paid_from_cash",
			"recorded_at",
			"remarks",
			"posting_status",
			"receipt",
		],
	)
	breaks = rows(
		"DSR Break", ["name", "break_type", "started_at", "ended_at", "duration_minutes", "allowance"]
	)
	activities = rows(
		"DSR Dealer Activity",
		[
			"name",
			"customer",
			"status",
			"arrived_at",
			"departed_at",
			"outstanding_reviewed",
			"photo_exception",
			"visit_number",
			"travel_verification",
			"travel_distance_km",
			"travel_duration_seconds",
			"activity_duration_minutes",
			"reward_points",
			"reward_rule_version",
		],
	)
	customer_names = {}
	if activities:
		customer_names = {
			row.name: row.customer_name
			for row in frappe.get_all(
				"Customer",
				filters={"name": ["in", list({activity.customer for activity in activities})]},
				fields=["name", "customer_name"],
				limit_page_length=0,
			)
		}
	for number, activity in enumerate(activities, 1):
		activity.visit_number = number
		activity.customer_name = customer_names.get(activity.customer) or "Dealer"
	photos = rows("DSR Dealer Photo Evidence", ["name", "activity", "photo", "received_at"])
	ledger_rows = rows("DSR Cash Ledger", ["name", "transaction_type", "amount", "posting_time", "remarks"])
	stays = frappe.get_all(
		"DSR Night Stay",
		filters={"account": doc.account, "checked_out_at": ["is", "not set"]},
		fields=["name", "address", "state", "checked_in_at", "duty"],
	)
	fuel = fuel_entitlement(doc)
	from .meal_expenses import automatic_meals_enabled

	meals = (
		0
		if doc.get("no_visit_duty") or automatic_meals_enabled(doc)
		else sum(flt(r.allowance) for r in breaks)
	)
	valid = [r for r in collections if r.verification_status != "Reversed"]
	cash_expenses = sum(
		flt(r.amount) for r in expenses if r.paid_from_cash and r.posting_status != "Reversed"
	)
	duty_values = doc.as_dict()
	from .night_stay import state as night_stay_state

	return public_dates(
		{
			"night_stay": night_stay_state(doc),
			"duty": dict(duty_values, closed_gap_seconds=closed_gap_seconds(doc.name)),
			"available_cash": cash_balance(doc),
			"gps_accuracy": frappe.db.get_value("DSR GPS Point", doc.last_point, "accuracy")
			if doc.last_point
			else None,
			"collections": collections,
			"cash_collections": sum(flt(r.amount) for r in valid if r.payment_method == "Cash"),
			"collection_total": sum(flt(r.amount) for r in valid),
			"cash_expenses": cash_expenses,
			"expenses": expenses,
			"fuel_reimbursement": fuel,
			"meal_allowance": meals,
			"expense_total": fuel
			+ meals
			+ sum(
				flt(r.amount)
				for r in expenses
				if r.category != "Fuel Reimbursement" and r.posting_status != "Reversed"
			),
			"breaks": breaks,
			"activities": activities,
			"photos": photos,
			"ledger": ledger_rows,
			"night_stays": stays,
			"duty_minutes": duty_seconds(doc) / 60,
			"events": rows("DSR Tracking Event", ["event_type", "recorded_at", "details"]),
			"orders": readable_orders(
				filters={
					"owner": frappe.session.user,
					"company": settings().company,
					"transaction_date": doc.work_date,
				},
				fields=["name", "customer", "grand_total", "status", "currency"],
				limit_page_length=100,
			),
		}
	)


@frappe.whitelist()
def reports(period="Daily", date=None):
	account = identity()
	end = getdate(date) if date else getdate()
	if period == "Daily":
		start = end
	elif period == "Weekly":
		start = end - timedelta(days=end.weekday())
	elif period == "Monthly":
		start = end.replace(day=1)
	elif period == "Quarterly":
		start = end.replace(month=((end.month - 1) // 3) * 3 + 1, day=1)
	else:
		frappe.throw("Invalid report period.")
	rows = frappe.get_all(
		"DSR Duty Session",
		filters={"account": account, "work_date": ["between", [start, end]]},
		fields=[
			"name",
			"work_date",
			"status",
			"started_at",
			"ended_at",
			"verified_km",
			"opening_balance",
			"closing_balance",
			"fuel_rate",
			"no_visit_duty",
			"duty_off_reason",
		],
		order_by="work_date desc, creation desc",
		limit=100,
	)
	by_name = {row.name: row for row in rows}
	for row in rows:
		row.update(
			collections=0,
			expenses=0,
			fuel=fuel_entitlement(row),
			activities=0,
			orders=0,
			duty_minutes=duty_seconds(row) / 60,
		)
	coverage = set()
	if rows:
		filters = {"account": account, "duty": ["in", list(by_name)]}
		for collection in frappe.get_all(
			"DSR Collection", filters=filters, fields=["duty", "amount", "verification_status"]
		):
			if collection.verification_status != "Reversed":
				by_name[collection.duty].collections += flt(collection.amount)
		for expense in frappe.get_all(
			"DSR Expense Record",
			filters={
				**filters,
				"category": ["!=", "Fuel Reimbursement"],
				"posting_status": ["!=", "Reversed"],
			},
			fields=["duty", "amount"],
		):
			by_name[expense.duty].expenses += flt(expense.amount)
		from .meal_expenses import automatic_meals_enabled

		legacy_duties = {row.name for row in rows if not automatic_meals_enabled(row)}
		for meal in frappe.get_all("DSR Break", filters=filters, fields=["duty", "allowance"]):
			if meal.duty in legacy_duties:
				by_name[meal.duty].expenses += flt(meal.allowance)
		for activity in frappe.get_all(
			"DSR Dealer Activity",
			filters={**filters, "status": ["!=", "Deleted"]},
			fields=["duty", "customer", "status"],
		):
			by_name[activity.duty].activities += 1
			if activity.status == "Completed":
				coverage.add(activity.customer)
		movements = {name: [] for name in by_name}
		for movement in frappe.get_all(
			"DSR Cash Ledger",
			filters={**filters, "transaction_type": ["!=", "Opening"]},
			fields=["duty", "amount"],
		):
			movements[movement.duty].append(movement.amount)
		for row in rows:
			row.closing_balance = float(balance(row.opening_balance, movements[row.name]))
			row.expenses = float(money(row.expenses + row.fuel))
			row.collections = float(money(row.collections))
		order_counts = {}
		for order in readable_orders(
			filters={
				"owner": frappe.session.user,
				"company": settings().company,
				"transaction_date": ["between", [start, end]],
				"docstatus": ["!=", 2],
			},
			fields=["transaction_date"],
			limit_page_length=0,
		):
			order_counts[getdate(order.transaction_date)] = (
				order_counts.get(getdate(order.transaction_date), 0) + 1
			)
		for row in rows:
			row.orders = order_counts.get(getdate(row.work_date), 0)
	return public_dates(
		{
			"period": period,
			"from_date": start,
			"to_date": end,
			"days": rows,
			"counted_duties": sum(not row.get("no_visit_duty") for row in rows),
			"no_visit_duties": sum(bool(row.get("no_visit_duty")) for row in rows),
			"dealer_coverage": len(coverage),
		}
	)


@frappe.whitelist()
def search_items(search=""):
	identity()
	return frappe.get_list(
		"Item",
		filters={"disabled": 0, "is_sales_item": 1, "has_variants": 0},
		or_filters={
			"name": ["like", "%" + str(search)[:100] + "%"],
			"item_name": ["like", "%" + str(search)[:100] + "%"],
		},
		fields=["name", "item_name", "stock_uom"],
		limit_page_length=30,
	)


@frappe.whitelist(methods=["POST"])
def create_order(duty, customer, items, delivery_date, request_key):
	doc = active(duty)
	dealer(customer)
	# Stable per-user request key stored in an audit event avoids creating retry orders.
	order_key = "order:" + key(request_key, doc.account)
	existing = frappe.db.get_value(
		"DSR Tracking Event",
		{"duty": duty, "details": ["like", order_key + "|%"]},
		"details",
		for_update=True,
	)
	if not existing and doc.employee:
		existing = frappe.db.get_value(
			"DSR Tracking Event",
			{"duty": duty, "details": ["like", "order:" + key(request_key, doc.employee) + "|%"]},
			"details",
			for_update=True,
		)
	if existing:
		return existing.split("|", 1)[1]
	order = build_order(customer, items, delivery_date)
	order.insert()
	# A salesperson can save a request through an existing approval workflow.
	# Only ordinary submit permissions without a workflow can post it immediately.
	from frappe.model.workflow import get_workflow_name

	if not get_workflow_name("Sales Order") and frappe.has_permission("Sales Order", "submit", doc=order):
		order.submit()
	event(doc, "Order", order_key + "|" + order.name)
	return order.name


def build_order(customer, items, delivery_date):
	items = frappe.parse_json(items) if isinstance(items, str) else items
	if not isinstance(items, list) or not 1 <= len(items) <= 100:
		frappe.throw("Add at least one order item.")
	if getdate(delivery_date) < getdate():
		frappe.throw("Delivery date cannot be in the past.")
	order = frappe.new_doc("Sales Order")
	order.update(
		{
			"customer": customer,
			"company": settings().company,
			"transaction_date": getdate(),
			"delivery_date": getdate(delivery_date),
			"order_type": "Sales",
		}
	)
	if order.meta.has_field("custom_discount__as_per_list") and order.get("custom_discount__as_per_list") in (
		None,
		"",
	):
		# Existing SRV mandatory field: no additional discretionary discount in this workflow.
		order.custom_discount__as_per_list = 0

	for item in items:
		master = frappe.get_doc("Item", item["item_code"])
		master.check_permission("read")
		if master.disabled or not master.is_sales_item or master.has_variants:
			frappe.throw("Choose an enabled saleable item variant.")
		from srv_erp.selling.sales_order_uom import get_sales_order_uom

		allowed_uom, _group = get_sales_order_uom(master.item_group)
		row = order.append(
			"items",
			{
				"item_code": master.name,
				"qty": quantity(item["qty"]),
				"uom": allowed_uom or master.get("sales_uom") or master.stock_uom,
				"delivery_date": getdate(delivery_date),
			},
		)
		# New child defaults may be numeric zero; explicitly leave server pricing unset.
		for field in ("rate", "price_list_rate", "discount_percentage", "discount_amount"):
			row.set(field, None)
	# ERPNext derives rates, UOM, taxes and pricing rules; client totals are ignored.
	order.set_missing_values()
	order.calculate_taxes_and_totals()
	return order


@frappe.whitelist(methods=["POST"])
def preview_order(duty, customer, items, delivery_date):
	active(duty)
	dealer(customer)
	order = build_order(customer, items, delivery_date)
	order.check_permission("create")
	return {
		"items": [
			{"item_code": x.item_code, "qty": x.qty, "uom": x.uom, "rate": x.rate, "amount": x.amount}
			for x in order.items
		],
		"subtotal": order.total,
		"taxes": order.total_taxes_and_charges,
		"grand_total": order.grand_total,
		"currency": order.currency,
	}


@frappe.whitelist(methods=["POST"])
def enroll_device(account, device_name, public_key):
	if frappe.session.user != "Administrator":
		frappe.throw("Administrator must enroll camera devices.", frappe.PermissionError)
	from cryptography.hazmat.primitives import serialization
	from cryptography.hazmat.primitives.asymmetric import ec

	parsed = serialization.load_pem_public_key(public_key.encode())
	if not isinstance(parsed, ec.EllipticCurvePublicKey) or parsed.curve.name != "secp256r1":
		frappe.throw("Use an Android Keystore P-256 public key.")
	return insert(
		"DSR Mobile Device", account=account, device_name=device_name, public_key=public_key, enabled=1
	).name


@frappe.whitelist(methods=["POST"])
def revoke_device(device):
	if frappe.session.user != "Administrator":
		frappe.throw("Administrator must revoke a camera device.", frappe.PermissionError)
	doc = frappe.get_doc("DSR Mobile Device", device)
	doc.enabled = 0
	save(doc)
	return doc.name


# Minimal Business website APIs. Existing custody and ERP posting services are reused.
def validate_documents(documents):
	values = frappe.parse_json(documents) if isinstance(documents, str) else documents
	if not isinstance(values, dict) or any(
		values.get(n) not in (True, 1) for n in ("insurance", "puc", "rc", "fastag")
	):
		frappe.throw("Confirm Insurance, PUC, RC and FASTag before Duty ON.")
	return {"confirmed_" + n: 1 for n in ("insurance", "puc", "rc", "fastag")}


def prepare_visit_travel(row, doc):
	previous = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": doc.name, "status": "Completed"},
		fields=["name", "departed_at", "departure_latitude", "departure_longitude"],
		order_by="departed_at desc",
		limit=1,
	)
	origin = previous[0] if previous else None
	row.visit_number = frappe.db.sql(
		"select greatest(coalesce(max(visit_number),0),count(*))+1 from `tabDSR Dealer Activity` where duty=%s and name!=%s",
		(doc.name, row.name),
	)[0][0]
	row.origin_activity = origin.name if origin else None
	row.travel_started_at = origin.departed_at if origin else doc.started_at
	start = frappe.get_all(
		"DSR GPS Point",
		filters={"duty": doc.name},
		fields=["latitude", "longitude"],
		order_by="captured_at asc",
		limit=1,
	)
	row.origin_latitude = origin.departure_latitude if origin else (start[0].latitude if start else None)
	row.origin_longitude = origin.departure_longitude if origin else (start[0].longitude if start else None)
	row.travel_duration_seconds = max(
		0, (get_datetime(row.arrived_at) - get_datetime(row.travel_started_at)).total_seconds()
	)
	points = frappe.get_all(
		"DSR GPS Point",
		filters={"duty": doc.name, "captured_at": ["between", [row.travel_started_at, row.arrived_at]]},
		fields=["captured_at", "verified", "distance_km"],
		order_by="captured_at asc",
		limit_page_length=0,
	)
	max_gap = cint(settings().max_gap_seconds)
	boundaries = (
		[get_datetime(row.travel_started_at)]
		+ [get_datetime(p.captured_at) for p in points]
		+ [get_datetime(row.arrived_at)]
	)
	verified = (
		len(points) >= 2
		and all(p.verified for p in points)
		and all((b - a).total_seconds() <= max_gap for a, b in pairwise(boundaries))
	)
	row.travel_verification = (
		"Verified GPS samples" if verified else "Unverified — insufficient continuous GPS samples"
	)
	# First point may include a segment before departure. Exclude it.
	row.travel_distance_km = sum(flt(p.distance_km) for p in points[1:]) if verified else 0
	save(row)


def visible_visit_number(activity, duty):
	"""Number visible visits consecutively without rewriting audit identities."""
	names = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": ["!=", "Deleted"]},
		pluck="name",
		order_by="creation asc,name asc",
		limit_page_length=0,
	)
	return names.index(activity) + 1 if activity in names else None


@frappe.whitelist()
def visit_details(activity):
	row = frappe.get_doc("DSR Dealer Activity", activity)
	doc = duty_doc(row.duty)
	if row.status == "Deleted":
		frappe.throw("This pending visit was deleted.", frappe.PermissionError)
	if row.account != doc.account:
		frappe.throw("Visit access denied.", frappe.PermissionError)
	customer = dealer(row.customer)
	orders = readable_orders(
		filters={"custom_dsr_visit": row.name},
		fields=["name", "docstatus", "grand_total", "currency", "customer"],
	)
	visit = row.as_dict()
	visit["visit_number"] = visible_visit_number(row.name, row.duty)
	return public_dates(
		{
			"visit": visit,
			"dealer": {
				"name": customer.name,
				"customer_name": customer.customer_name,
				"mobile_no": customer.mobile_no,
			},
			"photos": frappe.get_all(
				"DSR Dealer Photo Evidence",
				filters={"activity": row.name, "photo": ["is", "set"]},
				fields=[
					"name",
					"photo",
					"captured_at",
					"received_at",
					"capture_source",
					"latitude",
					"longitude",
					"accuracy",
				],
			),
			"orders": orders,
			"collections": frappe.get_all(
				"DSR Collection",
				filters={"activity": row.name, "account": doc.account},
				fields=["name", "amount", "payment_method", "verification_status", "payment_entry"],
			),
			"outstanding": outstanding(row.customer),
		}
	)


@frappe.whitelist(methods=["POST"])
def browser_photo_challenge(activity):
	row, doc = activity_doc(activity)
	token = secrets.token_urlsafe(32)
	frappe.cache().set_value(
		"dsr-web-photo:" + token, {"activity": row.name, "account": doc.account}, expires_in_sec=120
	)
	return token


@frappe.whitelist(methods=["POST"])
def browser_photo(activity, challenge, image_base64, gps=None):
	from frappe.utils.file_manager import save_file
	from PIL import Image

	row, doc = activity_doc(activity)
	known = frappe.cache().get_value("dsr-web-photo:" + challenge)
	if known != {"activity": row.name, "account": doc.account}:
		frappe.throw("Camera session expired. Open the camera again.")
	point = location(gps) if gps is not None else {}
	try:
		if not isinstance(image_base64, str) or len(image_base64) > 7_000_000:
			raise ValueError()
		data = base64.b64decode(image_base64, validate=True)
		with Image.open(io.BytesIO(data)) as photo:
			if (
				photo.format != "JPEG"
				or not 10000 <= photo.width * photo.height <= 24_000_000
				or len(data) > 5_000_000
			):
				raise ValueError()
			photo.verify()
	except Exception:
		frappe.throw("Capture a valid JPEG photo, up to 5 MB.")
	evidence = insert(
		"DSR Dealer Photo Evidence",
		account=doc.account,
		duty=doc.name,
		activity=row.name,
		**point,
		captured_at=now_datetime(),
		received_at=now_datetime(),
		sha256=hashlib.sha256(data).hexdigest(),
		capture_source="Browser camera" if point else "Browser camera pending location",
		challenge=challenge,
	)
	previous = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		file = save_file(
			"shop-" + evidence.name + ".jpg", data, evidence.doctype, evidence.name, is_private=1
		)
	finally:
		frappe.flags.smart_dsr_evidence_write = previous
	evidence.photo = file.file_url
	save(evidence)
	if point:
		finish_browser_photo_location(row, doc, evidence, point)
	else:
		# Saving the photo must not wait for the device's GPS acquisition.
		row.arrived_at = evidence.captured_at
		save(row)
	frappe.cache().delete_value("dsr-web-photo:" + challenge)
	return public_dates(
		{
			k: evidence.get(k)
			for k in (
				"name",
				"photo",
				"captured_at",
				"received_at",
				"capture_source",
				"latitude",
				"longitude",
				"accuracy",
			)
		}
	)


def finish_browser_photo_location(row, doc, evidence, point):
	from .rewards import start_timer

	start_timer(row, evidence)
	before = str(row.arrived_at)
	row.arrived_at = evidence.captured_at
	row.update(point)
	prepare_visit_travel(row, doc)
	if frappe.db.exists(
		"DSR Dealer Photo Evidence",
		{"activity": row.name, "account": doc.account, "photo": ["is", "not set"]},
	):
		event(
			doc,
			"Exception",
			f"Visit {row.name}: photo retaken; visit time changed from {before} to {row.arrived_at}; current capture location recorded.",
		)


@frappe.whitelist(methods=["POST"])
def browser_photo_location(activity, photo, gps):
	"""Attach the capture's live GPS after its image has finished uploading."""
	row, doc = activity_doc(activity)
	evidence = frappe.get_doc("DSR Dealer Photo Evidence", photo)
	if (
		evidence.activity != row.name
		or evidence.account != doc.account
		or evidence.duty != doc.name
		or not evidence.photo
	):
		frappe.throw("Photo does not belong to this visit.", frappe.PermissionError)
	if evidence.capture_source == "Browser camera pending location":
		if (now_datetime() - get_datetime(evidence.received_at)).total_seconds() > 120:
			frappe.throw("Photo location session expired. Retake the shop photo.")
		point = location(gps)
		evidence.update(point)
		evidence.capture_source = "Browser camera"
		save(evidence)
		finish_browser_photo_location(row, doc, evidence, point)
	elif evidence.capture_source != "Browser camera":
		frappe.throw("This photo does not accept browser location updates.", frappe.PermissionError)
	return visit_details(activity)


@frappe.whitelist(methods=["POST"])
def save_visit_review(activity, review):
	row, _doc = activity_doc(activity)
	require_visit_photo(row, _doc.account)
	values = frappe.parse_json(review) if isinstance(review, str) else review
	categories = ("remarks",)
	if not isinstance(values, dict) or any(not isinstance(v, str) or len(v) > 2000 for v in values.values()):
		frappe.throw("Review fields must be text, up to 2000 characters each.")
	row.dealer_review = json.dumps({k: values.get(k, "") for k in categories})
	save(row)
	return row.name


@frappe.whitelist()
def previous_reviews(customer):
	dealer(customer)
	return public_dates(
		frappe.get_all(
			"DSR Dealer Activity",
			filters={
				"customer": customer,
				"account": identity(),
				"dealer_review": ["is", "set"],
				"status": ["!=", "Deleted"],
			},
			fields=["name", "arrived_at", "dealer_review"],
			order_by="arrived_at desc",
			limit=20,
		)
	)


@frappe.whitelist(methods=["POST"])
def visit_collection(
	activity, value, payment_method, request_key, allocations=None, transaction_reference="", remarks=""
):
	row, doc = activity_doc(activity)
	require_visit_photo(row, doc.account)
	prior = repeated("DSR Collection", request_key, doc.account)
	if prior and prior.activity != activity:
		frappe.throw("This request identifier belongs to another visit.")
	result = collect_payment(
		doc.name,
		row.customer,
		value,
		payment_method,
		request_key,
		allocations,
		transaction_reference,
		remarks,
	)
	collection = frappe.get_doc("DSR Collection", result["name"])
	collection.activity = row.name
	save(collection)
	# Manual overdue receipts are linked while recording the collection.
	return dict(
		result, accounting_status=collection.verification_status, outstanding=outstanding(row.customer)
	)


@frappe.whitelist(methods=["POST"])
def order_return_reference(activity):
	row, doc = activity_doc(activity)
	require_visit_photo(row, doc.account)
	token = secrets.token_urlsafe(32)
	frappe.cache().set_value(
		"dsr-order:" + token,
		{"activity": row.name, "user": frappe.session.user, "customer": row.customer},
		expires_in_sec=86400,
	)
	return {"token": token, "activity": row.name, "customer": row.customer}


@frappe.whitelist(methods=["POST"])
def link_visit_order(token, order):
	known = frappe.cache().get_value("dsr-order:" + token)
	if not known or known["user"] != frappe.session.user:
		frappe.throw("DSR return reference expired or invalid.", frappe.PermissionError)
	row, doc = activity_doc(known["activity"])
	require_visit_photo(row, doc.account)
	so = frappe.get_doc("Sales Order", order)
	so.check_permission("read")
	if (
		so.docstatus != 1
		or so.customer != row.customer
		or so.company != settings().company
		or so.owner != frappe.session.user
	):
		frappe.throw("Only your submitted order for this dealer and company can be linked.")
	if so.custom_dsr_visit and so.custom_dsr_visit != row.name:
		frappe.throw("Order already belongs to another visit.")
	so.db_set("custom_dsr_visit", row.name, update_modified=False)
	return row.name


@frappe.whitelist(methods=["POST"])
def end_workday(duty, gps=None, odometer_end=None, odometer_photo=None, duty_off_reason=None):
	if duty_doc(duty).status == "Finalized":
		return summary(duty)
	duty_off(
		duty, gps, odometer_end=odometer_end, odometer_photo=odometer_photo, duty_off_reason=duty_off_reason
	)
	return finalize(duty)


def protect_order_visit(doc, method=None):
	previous = doc.get_doc_before_save()
	old = previous.get("custom_dsr_visit") if previous else None
	if doc.get("custom_dsr_visit") != old:
		frappe.throw(
			"Link Sales Orders through the authenticated Smart DSR return workflow.", frappe.PermissionError
		)
