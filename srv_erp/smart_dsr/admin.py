"""Authenticated control-panel services. No salesperson impersonation or raw GL writes."""

from __future__ import annotations

import html
import io
import json
from datetime import timedelta

import frappe
from frappe.utils import cint, flt, get_datetime, getdate, now_datetime

from . import api
from .admin_permissions import (
	ADMIN_ROLE,
	FINANCE_ROLE,
	is_admin,
	require_admin,
	require_administrator,
	require_finance,
)
from .meal_expenses import legacy_allowance, legacy_allowance_total
from .policy import money

TABLES = {
	"vehicles": (
		"DSR Vehicle",
		"created_date",
		[
			"name",
			"registration_number",
			"insurance_available",
			"puc_available",
			"rc_available",
			"fastag_available",
			"vehicle_type",
			"make",
			"model",
			"fuel_type",
			"insurance_number",
			"insurance_expiry",
			"puc_number",
			"puc_expiry",
			"rc_number",
			"rc_expiry",
			"fastag_details",
			"status",
			"allocated_to",
			"added_by",
			"added_by_salesperson",
			"created_date",
		],
	),
	"duties": (
		"DSR Duty Session",
		"work_date",
		[
			"name",
			"account",
			"employee",
			"work_date",
			"status",
			"vehicle_number",
			"fuel_type",
			"started_at",
			"ended_at",
			"no_visit_duty",
			"duty_off_reason",
			"start_location",
			"verified_km",
			"estimated_km",
			"gps_status",
			"opening_balance",
			"closing_balance",
			"confirmed_insurance",
			"confirmed_puc",
			"confirmed_rc",
			"confirmed_fastag",
		],
	),
	"visits": (
		"DSR Dealer Activity",
		"arrived_at",
		[
			"name",
			"account",
			"employee",
			"duty",
			"customer",
			"visit_number",
			"status",
			"arrived_at",
			"departed_at",
			"travel_distance_km",
			"travel_duration_seconds",
			"travel_verification",
			"dealer_review",
			"remarks",
			"outstanding_reviewed",
		],
	),
	"collections": (
		"DSR Collection",
		"collected_at",
		[
			"name",
			"account",
			"employee",
			"customer",
			"duty",
			"activity",
			"amount",
			"payment_method",
			"collected_at",
			"allocations",
			"payment_entry",
			"verification_status",
			"remarks",
			"transaction_reference",
		],
	),
	"expenses": (
		"DSR Expense Record",
		"recorded_at",
		[
			"name",
			"account",
			"employee",
			"duty",
			"category",
			"amount",
			"paid_from_cash",
			"recorded_at",
			"posting_status",
			"remarks",
			"receipt",
		],
	),
	"dsrs": (
		"DSR",
		"date",
		[
			"name",
			"owner",
			"date",
			"sales_person",
			"docstatus",
			"smart_dsr",
			"smart_duty",
			"opening_balance",
			"closing_balance",
			"km_travelled",
			"total_amount",
		],
	),
	"audit": (
		"DSR Admin Audit",
		"recorded_at",
		[
			"name",
			"actor",
			"affected_user",
			"employee",
			"record_type",
			"record_id",
			"action",
			"reason",
			"recorded_at",
			"transaction_type",
			"transaction_id",
			"outcome",
		],
	),
	"ledger": (
		"DSR Cash Ledger",
		"posting_time",
		[
			"name",
			"account",
			"employee",
			"duty",
			"transaction_type",
			"amount",
			"source_type",
			"source_name",
			"posting_time",
			"remarks",
		],
	),
	"gps": (
		"DSR Tracking Event",
		"recorded_at",
		["name", "account", "duty", "event_type", "recorded_at", "details"],
	),
	"outstanding": (
		"Sales Invoice",
		"due_date",
		["name", "customer", "posting_date", "due_date", "outstanding_amount", "currency", "company"],
	),
}


def record_count(doctype, filters=None, or_filters=None):
	if not or_filters:
		return frappe.db.count(doctype, filters=filters)
	return cint(
		frappe.get_all(
			doctype,
			filters=filters,
			or_filters=or_filters,
			fields=["count(name) as total"],
			limit_page_length=0,
		)[0].total
	)


def args(value=None):
	value = frappe.parse_json(value) if isinstance(value, str) else value
	if value is None:
		return {}
	if not isinstance(value, dict):
		frappe.throw("Invalid filters.")
	return value


def reason(value):
	value = str(value or "").strip()
	if not value or len(value) > 2000:
		frappe.throw("Enter an administrative reason (up to 2000 characters).")
	return value


def audit_key(request_key):
	return api.key(request_key, frappe.session.user)


def prior(request_key):
	name = frappe.db.get_value(
		"DSR Admin Audit", {"request_key": audit_key(request_key)}, "name", for_update=True
	)
	return frappe.get_doc("DSR Admin Audit", name) if name else None


def audit(action, record, before, after, why, request_key, transaction=None, outcome="Applied"):
	data = dict(
		doctype="DSR Admin Audit",
		actor=frappe.session.user,
		affected_user=record.get("account") or record.get("affected_user") or record.get("user_id"),
		employee=record.get("employee") or (record.name if record.doctype == "Employee" else None),
		record_type=record.doctype,
		record_id=record.name,
		action=action,
		original_value=frappe.as_json(before),
		updated_value=frappe.as_json(after),
		reason=reason(why),
		recorded_at=now_datetime(),
		request_key=audit_key(request_key),
		outcome=outcome,
	)
	if transaction:
		data.update(transaction_type=transaction[0], transaction_id=transaction[1])
	doc = frappe.get_doc(data)
	doc.flags.smart_dsr_admin_audit = True
	return doc.insert(ignore_permissions=True)


def locked_record(doctype, name):
	row = frappe.get_doc(doctype, name)
	account = (
		row.get("account")
		or row.get("affected_user")
		or row.get("added_by")
		or row.get("user_id")
		or row.get("owner")
	)
	if doctype != "DSR Vehicle":
		require_visible_account(account)
	if account:
		frappe.db.sql("select name from `tabUser` where name=%s for update", account)
	return frappe.get_doc(doctype, name, for_update=True)


def response_audit(doc):
	return {
		"audit": doc.name,
		"record": doc.record_id,
		"transaction": doc.transaction_id,
		"outcome": doc.outcome,
	}


def bounds(filters):
	start = getdate(filters.get("from_date") or filters.get("date") or getdate())
	end = getdate(filters.get("to_date") or filters.get("date") or start)
	if end < start:
		frappe.throw("End date must be on or after start date.")
	return start, end


VISIBLE_ROLE_PROFILES = ("Sales", "Sales Manager", "Administrator")


def visible_accounts(account=None):
	where = {"role_profile_name": ["in", VISIBLE_ROLE_PROFILES], "name": ["!=", "Guest"]}
	if account:
		where["name"] = account
	return frappe.get_all("User", filters=where, pluck="name", limit_page_length=0)


def require_visible_account(account):
	if not account or not visible_accounts(account):
		frappe.throw(
			"This User's Role Profile is outside the Smart DSR control panel scope.", frappe.PermissionError
		)


def account_scope(accounts):
	return ["in", accounts or ["__no_matching_dsr_user__"]]


def conditions(dataset, filters):
	_dt, datefield, fields = TABLES[dataset]
	if dataset == "vehicles":
		# Administrators can manage allocations across the fleet.
		accounts = []
		where = {"allocated_to": filters["account"]} if filters.get("account") else {}
	else:
		accounts = visible_accounts(filters.get("account"))
		where = {
			"affected_user"
			if dataset == "audit"
			else "owner"
			if dataset == "dsrs"
			else "account": account_scope(accounts)
		}
	if dataset != "vehicles" and not filters.get("all_dates"):
		start, end = bounds(filters)
		where[datefield] = [
			"between",
			[
				str(start),
				str(end) if datefield in ("work_date", "date", "due_date") else str(end) + " 23:59:59.999999",
			],
		]
	if dataset == "outstanding":
		where.pop("account", None)
		where.update(docstatus=1, outstanding_amount=[">", 0], company=api.settings().company)
		customers = frappe.get_all(
			"DSR Dealer Activity",
			filters={"account": account_scope(accounts)},
			pluck="customer",
			distinct=True,
			limit_page_length=0,
		)
		where["customer"] = ["in", customers or ["__no_matching_dsr_customer__"]]
	if filters.get("duty") and "duty" in fields:
		where["duty"] = filters["duty"]
	if filters.get("customer") and "customer" in fields:
		where["customer"] = (
			filters["customer"]
			if dataset != "outstanding" or filters["customer"] in customers
			else "__no_matching_dsr_customer__"
		)
	if filters.get("visit_number") and dataset == "visits":
		where["visit_number"] = cint(filters["visit_number"])
	statusfield = {
		"collections": "verification_status",
		"expenses": "posting_status",
		"dsrs": "docstatus",
		"audit": "outcome",
	}.get(dataset, "status")
	if filters.get("status") and (statusfield in fields):
		where[statusfield] = filters["status"]
	# Each control is scoped to fields supported by its own section.
	section_fields = {
		"vehicles": ("fuel_type",),
		"collections": ("payment_method",),
		"expenses": ("category",),
		"audit": ("record_type",),
	}
	for field in section_fields.get(dataset, ()):
		if filters.get(field):
			where[field] = filters[field]
	if dataset == "gps":
		where["event_type"] = ["in", ["Interrupted", "Exception", "Geofence Unknown", "Geofence Outside"]]
	return where


def vehicle_creators(rows):
	accounts = list(
		{row.get(field) for row in rows for field in ("added_by", "allocated_to") if row.get(field)}
	)
	users = (
		frappe.get_all(
			"User", filters={"name": ["in", accounts]}, fields=["name", "full_name"], limit_page_length=0
		)
		if accounts
		else []
	)
	names = {user.name: user.full_name or user.name for user in users}
	for row in rows:
		row["allocated_to_name"] = names.get(
			row.get("allocated_to"), row.get("allocated_to") or "Unallocated"
		)
		row["added_by_name"] = names.get(row.get("added_by"), row.get("added_by") or "—")


def duty_enrich(rows):
	accounts = list({row.account for row in rows if row.account})
	names = (
		{
			user.name: user.full_name
			for user in frappe.get_all(
				"User", filters={"name": ["in", accounts]}, fields=["name", "full_name"], limit_page_length=0
			)
		}
		if accounts
		else {}
	)
	for row in rows:
		doc = frappe.get_doc("DSR Duty Session", row.name)
		row["salesperson_name"] = names.get(row.account) or row.account
		row["closing_balance"] = cash_at(doc)
		row["duty_minutes"] = api.duty_seconds(doc) / 60
		row["total_visits"] = frappe.db.count(
			"DSR Dealer Activity", {"duty": row.name, "status": ["!=", "Deleted"]}
		)
		row["collections"] = flt(
			frappe.db.sql(
				"select coalesce(sum(amount),0) from `tabDSR Collection` where duty=%s and verification_status!='Reversed'",
				row.name,
			)[0][0]
		)
		row["fuel_reimbursement"] = api.fuel_entitlement(doc)
		row["meal_allowance"] = legacy_allowance(row)
	return rows


def cash_at(doc, as_of=None):
	# Reports must not hold financial row locks while rendering/exporting.
	cutoff = str(getdate(as_of)) + " 23:59:59.999999" if as_of else None
	return float(api.balance(doc.opening_balance, api.cash_movements(doc, as_of=cutoff)))


def people(filters, page, page_size, balances=False):
	where = {"name": ["!=", "Guest"], "role_profile_name": ["in", VISIBLE_ROLE_PROFILES]}
	if filters.get("account"):
		where["name"] = filters["account"]
	if filters.get("smart_dsr_disabled") in (0, 1, "0", "1"):
		where["smart_dsr_disabled"] = cint(filters["smart_dsr_disabled"])
	search = str(filters.get("search") or "")[:100]
	or_filters = None
	if search:
		or_filters = [
			["User", field, "like", "%" + search + "%"] for field in ("name", "full_name", "username")
		]
	rows = frappe.get_all(
		"User",
		filters=where,
		or_filters=or_filters,
		fields=["name", "full_name", "enabled", "smart_dsr_disabled"],
		order_by="full_name asc,name asc",
		start=(page - 1) * page_size,
		page_length=page_size,
	)
	total = record_count("User", filters=where, or_filters=or_filters)
	for row in rows:
		row.account = row.name
		row.employee_name = row.full_name or row.name
		dw = {"account": row.name}
		if balances and filters.get("balance_as_of"):
			dw["work_date"] = ["<=", filters["balance_as_of"]]
		if not balances and not filters.get("all_dates"):
			dw["work_date"] = ["between", list(bounds(filters))]
		names = frappe.get_all(
			"DSR Duty Session", filters=dw, pluck="name", order_by="work_date desc, creation desc", limit=1
		)
		if names:
			duty = frappe.get_doc("DSR Duty Session", names[0])
			row.update(
				{
					"duty": duty.name,
					"duty_status": duty.status,
					"opening_balance": duty.opening_balance,
					"closing_balance": cash_at(duty, filters.get("balance_as_of")),
					"verified_km": duty.verified_km,
					"duty_minutes": api.duty_seconds(duty) / 60,
					"total_visits": frappe.db.count(
						"DSR Dealer Activity", {"duty": duty.name, "status": ["!=", "Deleted"]}
					),
					"collections": flt(
						frappe.db.sql(
							"select coalesce(sum(amount),0) from `tabDSR Collection` where duty=%s and verification_status!='Reversed'",
							duty.name,
						)[0][0]
					),
				}
			)
		else:
			opening = frappe.db.get_value(
				"DSR Cash Ledger",
				{
					"account": row.name,
					"transaction_type": "Opening",
					"duty": ["is", "not set"],
					**(
						{"posting_time": ["<=", str(getdate(filters["balance_as_of"])) + " 23:59:59.999999"]}
						if filters.get("balance_as_of")
						else {}
					),
				},
				"amount",
			)
			row.update(
				duty_status="Off duty",
				opening_balance=opening,
				closing_balance=opening,
				verified_km=0,
				duty_minutes=0,
				total_visits=0,
				collections=0,
			)
		# People, profile details and Opening Balances must show the same cash
		# allocation, including admin additions/returns during and between duties.
		from .cash_allocations import balances as account_balances

		row.update(account_balances(row.name, duty if names else None, filters.get("balance_as_of")))
	return {"rows": rows, "total": total, "page": page, "page_size": page_size}


@frappe.whitelist()
def bootstrap():
	require_admin()
	return {
		"user": frappe.session.user,
		"can_manage_users": frappe.session.user == "Administrator",
		"can_edit_user_profiles": bool(frappe.has_permission("User", "write")),
		"can_create_users": bool(frappe.has_permission("User", "create")),
		"can_finance": is_admin(),
		"users": frappe.get_all(
			"User",
			filters={"name": ["!=", "Guest"], "role_profile_name": ["in", VISIBLE_ROLE_PROFILES]},
			fields=["name", "full_name"],
			order_by="full_name",
			limit=200,
		),
		"today": str(getdate()),
		"currency": frappe.get_cached_value("Company", api.settings().company, "default_currency")
		if frappe.db.get_single_value("DSR Settings", "company")
		else "INR",
	}


@frappe.whitelist()
def visit_dealer_options(account=None, dataset="visits"):
	require_admin()
	if dataset not in ("visits", "collections", "outstanding"):
		frappe.throw("Select a valid dealer filter section.")
	accounts = visible_accounts(account)
	if not accounts:
		return []
	customers = frappe.get_all(
		"DSR Collection" if dataset == "collections" else "DSR Dealer Activity",
		filters={"account": account_scope(accounts)},
		pluck="customer",
		distinct=True,
		limit_page_length=0,
	)
	if not customers:
		return []
	return frappe.get_all(
		"Customer",
		filters={"name": ["in", customers]},
		fields=["name", "customer_name"],
		order_by="customer_name asc, name asc",
		limit_page_length=0,
	)


def ledger_dealer_details(rows):
	"""Enrich only collections belonging to each already-authorized ledger account."""
	if not rows:
		return
	accounts = list({row.get("account") for row in rows if row.get("account")})
	references = {
		row.get("source_name")
		for row in rows
		if row.get("source_type") == "DSR Cash Ledger" and row.get("source_name")
	}
	originals = (
		{
			row.name: row
			for row in frappe.get_all(
				"DSR Cash Ledger",
				filters={"name": ["in", list(references)], "account": ["in", accounts]},
				fields=["name", "account", "source_type", "source_name"],
				limit_page_length=0,
			)
		}
		if references
		else {}
	)

	def collection_ref(row):
		source = originals.get(row.get("source_name")) if row.get("source_type") == "DSR Cash Ledger" else row
		return (
			source.get("source_name")
			if source
			and source.get("account") == row.get("account")
			and source.get("source_type") == "DSR Collection"
			else None
		)

	names = list({name for row in rows if (name := collection_ref(row))})
	if not names:
		return
	collections = {
		row.name: row
		for row in frappe.get_all(
			"DSR Collection",
			filters={"name": ["in", names], "account": ["in", accounts]},
			fields=[
				"name",
				"account",
				"customer",
				"amount",
				"collected_at",
				"payment_method",
				"transaction_reference",
				"verification_status",
			],
			limit_page_length=0,
		)
	}
	customers = list({row.customer for row in collections.values() if row.customer})
	dealers = (
		{
			row.name: row
			for row in frappe.get_all(
				"Customer",
				filters={"name": ["in", customers]},
				fields=["name", "customer_name", "mobile_no"],
				limit_page_length=0,
			)
		}
		if customers
		else {}
	)
	for row in rows:
		collection = collections.get(collection_ref(row))
		if not collection or collection.account != row.get("account"):
			continue
		dealer = dealers.get(collection.customer)
		row["dealer_details"] = {
			"name": dealer.customer_name if dealer else collection.customer,
			"dealer_id": collection.customer,
			"mobile_no": dealer.mobile_no if dealer else None,
		}
		row["collection_details"] = {
			"collection": collection.name,
			"collected_at": collection.collected_at,
			"payment_method": collection.payment_method,
			"transaction_reference": collection.transaction_reference,
			"status": collection.verification_status,
			"amount": collection.amount,
		}


@frappe.whitelist()
def list_records(dataset, filters=None, page=1, page_size=20):
	require_admin()
	filters = args(filters)
	page = max(1, cint(page))
	page_size = min(100, max(1, cint(page_size)))
	if dataset in ("people", "balances"):
		return api.public_dates(people(filters, page, page_size, dataset == "balances"))
	if dataset not in TABLES:
		frappe.throw("Unknown administrative dataset.")
	dt, datefield, fields = TABLES[dataset]
	where = conditions(dataset, filters)
	search = str(filters.get("search") or "")[:100]
	searchable = [
		f
		for f in [
			"name",
			"account",
			"customer",
			"vehicle_number",
			"registration_number",
			"make",
			"model",
			"added_by",
			"actor",
			"record_id",
			"category",
			"remarks",
			"transaction_reference",
			"payment_entry",
			"sales_person",
			"owner",
			"action",
			"reason",
			"details",
		]
		if f in fields
	]
	if dataset == "vehicles":
		searchable = ["registration_number"]
	elif dataset == "duties":
		searchable = ["name", "account", "vehicle_number"]
	or_filters = {f: ["like", "%" + search + "%"] for f in searchable} if search else None
	rows = frappe.get_all(
		dt,
		filters=where,
		or_filters=or_filters,
		fields=fields,
		order_by=datefield + " desc,name desc",
		start=(page - 1) * page_size,
		page_length=page_size,
	)
	if dataset == "ledger":
		ledger_dealer_details(rows)
	if dataset == "vehicles":
		vehicle_creators(rows)
	if dataset == "duties":
		duty_enrich(rows)
	if dataset == "visits":
		for row in rows:
			row.photo = frappe.db.get_value(
				"DSR Dealer Photo Evidence", {"activity": row.name, "photo": ["is", "set"]}, "photo"
			)
			row.collections = flt(
				frappe.db.sql(
					"select coalesce(sum(amount),0) from `tabDSR Collection` where activity=%s and verification_status!='Reversed'",
					row.name,
				)[0][0]
			)
			row.sales_orders = frappe.get_all(
				"Sales Order", filters={"custom_dsr_visit": row.name}, pluck="name", limit=30
			)
	if dataset == "dsrs":
		for row in rows:
			if row.smart_duty:
				duty = frappe.get_doc("DSR Duty Session", row.smart_duty)
				row.opening_balance = duty.opening_balance
				row.closing_balance = cash_at(duty)
				row.km_travelled = duty.verified_km
	if dataset == "expenses":
		for row in rows:
			row.cash_impact = 0
	return api.public_dates(
		{
			"rows": rows,
			"total": record_count(dt, filters=where, or_filters=or_filters),
			"page": page,
			"page_size": page_size,
		}
	)


@frappe.whitelist()
def overview(filters=None):
	require_admin()
	filters = args(filters)
	start, end = bounds(filters)
	account = filters.get("account")
	dw = {} if filters.get("all_dates") else {"work_date": ["between", [start, end]]}
	dw["account"] = account_scope(visible_accounts(account))
	duty_names = frappe.get_all("DSR Duty Session", filters=dw, pluck="name", limit_page_length=0)
	scope = {"duty": ["in", duty_names or ["__none__"]]}
	total = frappe.db.count(
		"User",
		{
			"enabled": 1,
			"role_profile_name": ["in", VISIBLE_ROLE_PROFILES],
			"name": ["!=", "Guest"],
			"smart_dsr_disabled": 0,
			**({"name": account} if account else {}),
		},
	)
	on = len(
		frappe.get_all(
			"DSR Duty Session",
			filters={**dw, "status": "Active"},
			pluck="account",
			distinct=True,
			limit_page_length=0,
		)
	)

	def aggregate(dt, expression, extra=""):
		# Dataset scope is bound, expressions are internal constants.
		return flt(
			frappe.db.sql(
				f"select coalesce({expression},0) from `tab{dt}` where duty in %(duties)s " + extra,
				{"duties": tuple(duty_names or ["__none__"])},
			)[0][0]
		)

	cash = aggregate(
		"DSR Collection", "sum(amount)", "and verification_status!='Reversed' and payment_method='Cash'"
	)
	noncash = aggregate(
		"DSR Collection", "sum(amount)", "and verification_status!='Reversed' and payment_method!='Cash'"
	)
	expenses = aggregate(
		"DSR Expense Record",
		"sum(amount)",
		"and posting_status!='Reversed' and category!='Fuel Reimbursement'",
	)
	fuel_reimbursement = flt(
		frappe.db.sql(
			"select coalesce(sum(verified_km*fuel_rate),0) from `tabDSR Duty Session` where name in %(duties)s and coalesce(no_visit_duty,0)=0",
			{"duties": tuple(duty_names or ["__none__"])},
		)[0][0]
	)
	meal_allowances = legacy_allowance_total(duty_names)
	reimbursements = fuel_reimbursement + meal_allowances
	legacy_pending = {"docstatus": 0, "smart_dsr": 0, "owner": account_scope(visible_accounts(account))}
	if not filters.get("all_dates"):
		legacy_pending["date"] = ["between", [start, end]]
	return {
		"total_salespersons": total,
		"counted_duties": frappe.db.count("DSR Duty Session", {**dw, "no_visit_duty": 0}),
		"no_visit_duties": frappe.db.count("DSR Duty Session", {**dw, "no_visit_duty": 1}),
		"on_duty": on,
		"off_duty": max(0, total - on),
		"party_visits": frappe.db.count("DSR Dealer Activity", {**scope, "status": ["!=", "Deleted"]}),
		"cash_collections": cash,
		"noncash_collections": noncash,
		"expenses": expenses + reimbursements,
		"fuel_reimbursement": fuel_reimbursement,
		"meal_allowances": meal_allowances,
		"other_expenses": expenses,
		"cash_expenses": aggregate(
			"DSR Expense Record", "sum(amount)", "and posting_status!='Reversed' and paid_from_cash=1"
		),
		"outstanding_reviewed": aggregate("DSR Dealer Activity", "sum(outstanding_reviewed)"),
		"pending_review": frappe.db.count("DSR Duty Session", {**dw, "status": "Closed"})
		+ frappe.db.count("DSR", legacy_pending),
		"gps_exceptions": frappe.db.count(
			"DSR Tracking Event",
			{
				**scope,
				"event_type": ["in", ["Interrupted", "Exception", "Geofence Unknown", "Geofence Outside"]],
			},
		),
	}


@frappe.whitelist()
def balance_details(user):
	require_admin()
	require_visible_account(user)
	if not frappe.db.exists("User", user):
		frappe.throw("Select an existing User.")
	names = frappe.get_all(
		"DSR Duty Session",
		filters={"account": user},
		pluck="name",
		order_by="work_date desc, creation desc",
		limit=1,
	)
	final = frappe.get_all(
		"DSR Duty Session",
		filters={"account": user, "status": "Finalized"},
		fields=["name", "closing_balance"],
		order_by="work_date desc",
		limit=1,
	)
	initial = frappe.db.get_value(
		"DSR Cash Ledger",
		{"account": user, "transaction_type": "Opening", "duty": ["is", "not set"]},
		"amount",
	)
	duty = frappe.get_doc("DSR Duty Session", names[0]) if names else None
	from .cash_allocations import balances as account_balances

	cash = account_balances(user, duty)
	return api.public_dates(
		{
			"user": user,
			"initial_opening": initial,
			"current_duty": duty.as_dict() if duty else None,
			"current_cash": cash["closing_balance"],
			"opening_balance": cash["opening_balance"],
			"previous_finalized": final[0] if final else None,
			"ledger": list_records("ledger", {"account": user, "all_dates": True}, 1, 30),
		}
	)


@frappe.whitelist()
def details(dataset, name):
	require_admin()
	if dataset in ("people", "balances"):
		result = balance_details(name)
		result["profile"] = people({"account": name, "all_dates": True}, 1, 1)["rows"][0]
		result["duties"] = list_records("duties", {"account": name, "all_dates": True}, 1, 30)
		result["dsrs"] = list_records("dsrs", {"account": name, "all_dates": True}, 1, 30)
		return api.public_dates(result)
	if dataset not in TABLES:
		frappe.throw("Unknown record type.")
	dt = TABLES[dataset][0]
	if not frappe.db.exists(dt, {**conditions(dataset, {"all_dates": True}), "name": name}):
		frappe.throw("This record is outside the Smart DSR control panel scope.", frappe.PermissionError)
	row = frappe.get_doc(dt, name)
	result = {"record": row.as_dict()}
	if dataset == "ledger":
		ledger_dealer_details([result["record"]])
	if dataset == "vehicles":
		vehicle_creators([result["record"]])
	if dataset == "dsrs" and row.smart_duty:
		return details("duties", row.smart_duty)
	if dataset == "duties":
		result["cash"] = cash_at(row)
		result["duration_minutes"] = api.duty_seconds(row) / 60
		result["start_gps"] = frappe.get_all(
			"DSR GPS Point",
			filters={"duty": name},
			fields=["latitude", "longitude", "accuracy", "captured_at", "verified"],
			order_by="captured_at asc",
			limit=1,
		)
		result["end_gps"] = (
			frappe.get_all(
				"DSR GPS Point",
				filters={"duty": name, "captured_at": ["<=", row.ended_at]},
				fields=["latitude", "longitude", "accuracy", "captured_at", "verified"],
				order_by="captured_at desc",
				limit=1,
			)
			if row.ended_at
			else []
		)
		result["ending_location_note"] = (
			"Last available GPS sample before Duty OFF, with its actual capture time. Missing ending locations are not invented."
		)
		result["reimbursements"] = {
			"fuel_reimbursement": api.fuel_entitlement(row),
			"meal_allowances": legacy_allowance(row),
			"other_expenses": flt(
				frappe.db.sql(
					"select coalesce(sum(amount),0) from `tabDSR Expense Record` where duty=%s and category!='Fuel Reimbursement' and posting_status!='Reversed'",
					row.name,
				)[0][0]
			),
		}
		for key in ("visits", "collections", "expenses", "ledger", "gps"):
			result[key] = list_records(key, {"duty": name, "all_dates": True}, 1, 100)
		result["orders"] = frappe.get_all(
			"Sales Order",
			filters={
				"custom_dsr_visit": [
					"in",
					frappe.get_all(
						"DSR Dealer Activity", filters={"duty": name}, pluck="name", limit_page_length=0
					)
					or ["__none__"],
				]
			},
			fields=["name", "customer", "docstatus", "grand_total", "currency"],
			limit=100,
		)
	if dataset == "visits":
		result["photos"] = frappe.get_all(
			"DSR Dealer Photo Evidence",
			filters={"activity": name},
			fields=["name", "photo", "captured_at", "accuracy", "capture_source"],
			limit=100,
		)
		result["collections"] = frappe.get_all(
			"DSR Collection", filters={"activity": name}, fields=TABLES["collections"][2], limit=100
		)
		result["orders"] = frappe.get_all(
			"Sales Order",
			filters={"custom_dsr_visit": name},
			fields=["name", "customer", "grand_total", "docstatus"],
			limit=100,
		)
		result["reviews"] = frappe.parse_json(row.dealer_review or "{}")
	if dataset in ("collections", "expenses"):
		result["ledger"] = frappe.get_all(
			"DSR Cash Ledger",
			filters={"source_type": dt, "source_name": name},
			fields=TABLES["ledger"][2],
			limit=100,
		)
	if dataset in ("collections", "expenses"):
		ledger_dealer_details(result["ledger"])
	result["audit"] = frappe.get_all(
		"DSR Admin Audit",
		filters={"record_type": dt, "record_id": name},
		fields=TABLES["audit"][2],
		order_by="recorded_at desc",
		limit=100,
	)
	return api.public_dates(result)


@frappe.whitelist(methods=["POST"])
def manage_user(user, reason_text, request_key, sales_roles=None, access_enabled=None, profile_changes=None):
	require_administrator()
	require_visible_account(user)
	why = reason(reason_text)
	frappe.db.sql("select name from `tabUser` where name=%s for update", user)
	previous = prior(request_key)
	if previous:
		return response_audit(previous)
	if user == "Guest":
		frappe.throw("Guest cannot be enabled for Smart DSR.")
	doc = frappe.get_doc("User", user, for_update=True)
	before = {
		"smart_dsr_disabled": doc.smart_dsr_disabled,
		"roles": [r.role for r in doc.roles],
		"profile": {key: doc.get(key) for key in ("first_name", "middle_name", "last_name", "mobile_no")},
	}
	if profile_changes is not None:
		changes = args(profile_changes)
		if not changes or not set(changes).issubset({"first_name", "middle_name", "last_name", "mobile_no"}):
			frappe.throw("Only name and mobile number can be edited here.")
		for key, value in changes.items():
			if not isinstance(value, str) or len(value) > 140:
				frappe.throw("Enter valid profile details (up to 140 characters).")
			if key == "first_name" and not value.strip():
				frappe.throw("First name is required.")
			doc.set(key, value.strip())
	if sales_roles is not None:
		roles = frappe.parse_json(sales_roles) if isinstance(sales_roles, str) else sales_roles
		if not isinstance(roles, list) or not set(roles).issubset({"Sales User", "Sales Rapl"}):
			frappe.throw("Only Sales User and Sales Rapl can be assigned here.")
		keep = [r.role for r in doc.roles if r.role not in ("Sales User", "Sales Rapl")]
		doc.set("roles", [{"role": r} for r in sorted(set(keep + roles))])
	if access_enabled is not None:
		if user == "Administrator" and not cint(access_enabled):
			frappe.throw("Administrator control access cannot be disabled here.")
		doc.smart_dsr_disabled = not cint(access_enabled)
	doc.save(ignore_permissions=True)
	after = {
		"smart_dsr_disabled": doc.smart_dsr_disabled,
		"roles": [r.role for r in doc.roles],
		"profile": {key: doc.get(key) for key in ("first_name", "middle_name", "last_name", "mobile_no")},
	}
	record = frappe._dict(doctype="User", name=user, account=user)
	return response_audit(audit("Manage User", record, before, after, why, request_key))


@frappe.whitelist(methods=["POST"])
def opening_balance(user, value, reason_text, request_key):
	require_finance()
	require_visible_account(user)
	why = reason(reason_text)
	frappe.db.sql("select name from `tabUser` where name=%s for update", user)
	old = prior(request_key)
	if old:
		return response_audit(old)
	name = api.initialize_balance(user, value, "admin-initial:" + request_key, why)
	record = frappe._dict(doctype="User", name=user, account=user)
	return response_audit(
		audit(
			"Initial opening balance",
			record,
			None,
			{"opening_balance": str(api.money(value))},
			why,
			request_key,
			("DSR Cash Ledger", name),
		)
	)


@frappe.whitelist(methods=["POST"])
def manage_vehicle(values, reason_text=None, request_key=None, name=None):
	require_admin()
	why = reason(
		str(reason_text or "").strip()
		or (
			"Vehicle updated from Smart DSR control panel."
			if name
			else "Vehicle added from Smart DSR control panel."
		)
	)
	old_audit = prior(request_key)
	if old_audit:
		return response_audit(old_audit)
	values = frappe.parse_json(values) if isinstance(values, str) else values
	data = api.vehicle_values(values)
	if not name:
		api.require_vehicle_documents(data)
	allocation = str(values.get("allocated_to") or "").strip()
	if not allocation:
		frappe.throw("Select the salesperson who will use this vehicle.")
	api.prepare_vehicle_allocation(allocation, name)
	data["allocated_to"] = allocation
	status = values.get("status", "Active")
	if status not in ("Active", "Inactive"):
		frappe.throw("Select Active or Inactive status.")
	if name:
		doc = locked_record("DSR Vehicle", name)
		before = {field: doc.get(field) for field in [*data, "status"]}
		if values.get("status") not in ("Active", "Inactive"):
			frappe.throw("Select Active or Inactive status.")
		data["status"] = values["status"]
		doc.update(data)
		doc.flags.smart_dsr_write = True
		doc.save(ignore_permissions=True)
		action = "Update vehicle"
	else:
		if frappe.db.exists("DSR Vehicle", {"registration_number": data["registration_number"]}):
			frappe.throw("This vehicle registration number already exists.")
		before = None
		doc = api.insert(
			"DSR Vehicle",
			**data,
			status=status,
			added_by=frappe.session.user,
			added_by_salesperson=api.vehicle_employee(frappe.session.user),
			created_date=now_datetime(),
		)
		action = "Add vehicle"
	return response_audit(
		audit(
			action,
			doc,
			before,
			{field: doc.get(field) for field in [*data, "status", "added_by", "added_by_salesperson"]},
			why,
			request_key,
		)
	)


@frappe.whitelist(methods=["POST"])
def record_opening_movement(
	user, action, value, request_key, reason_text=None, expected_balance=None, expected_opening=None
):
	require_finance()
	require_visible_account(user)
	if action not in ("add", "return"):
		frappe.throw("Choose Add Opening Amount or Record Returned Cash.")
	amount = api.amount(value)
	if action == "add" and money(amount) > money(1_000_000):
		frappe.throw("Amount to Add cannot exceed ₹10,00,000 per entry.")
	frappe.db.sql("select name from `tabUser` where name=%s for update", user)
	old = prior(request_key)
	if old:
		return response_audit(old)
	why = reason(reason_text)
	from . import cash_allocations

	doc = cash_allocations.latest_duty(user, lock=True)
	before = cash_allocations.balances(user, doc, lock=True)
	for expected, field in ((expected_balance, "closing_balance"), (expected_opening, "opening_balance")):
		if expected is not None:
			try:
				matches = money(expected) == money(before[field] or 0)
			except (ValueError, ArithmeticError):
				frappe.throw("Enter a valid balance for confirmation.")
			if not matches:
				frappe.throw("The balance changed. Reopen the cash form to review the latest balance.")
	if action == "return" and (
		before["closing_balance"] is None or money(amount) > money(before["closing_balance"])
	):
		frappe.throw("Returned cash cannot exceed the salesperson's current closing balance.")
	kind = "Cash Advance" if action == "add" else "Cash Handover"
	movement_key = "opening-cash:" + api.key(request_key, user)
	if not doc and before["closing_balance"] is None:
		name = api.initialize_balance(user, amount, movement_key, why)
	elif doc and doc.status != "Finalized":
		name = api.cash_movement(doc.name, kind, amount, movement_key, why)
		doc.reload()
		api.recalculate(doc)
		api.save(doc)
	else:
		name = api.insert(
			"DSR Cash Ledger",
			account=user,
			transaction_type=kind,
			amount=amount if action == "add" else -amount,
			source_type="DSR Duty Session" if doc else "User",
			source_name=doc.name if doc else user,
			posting_time=now_datetime(),
			request_key=api.key(movement_key, user),
			remarks=why,
		).name
	after = cash_allocations.balances(user, doc, lock=True)
	record = frappe._dict(doctype="User", name=user, account=user)
	return response_audit(
		audit(
			"Add opening amount" if action == "add" else "Cash returned to administrator",
			record,
			before,
			after,
			why,
			request_key,
			("DSR Cash Ledger", name),
		)
	)


@frappe.whitelist(methods=["POST"])
def cash_adjustment(duty, transaction_type, value, reason_text, request_key, reversal_of=None):
	require_finance()
	why = reason(reason_text)
	doc = locked_record("DSR Duty Session", duty)
	old = prior(request_key)
	if old:
		return response_audit(old)
	before = {"closing_balance": api.cash_balance(doc)}
	name = api.cash_movement(duty, transaction_type, value, "admin-cash:" + request_key, why, reversal_of)
	doc.reload()
	api.recalculate(doc)
	api.save(doc)
	return response_audit(
		audit(
			transaction_type,
			doc,
			before,
			{"closing_balance": doc.closing_balance},
			why,
			request_key,
			("DSR Cash Ledger", name),
		)
	)


@frappe.whitelist(methods=["POST"])
def correct_metadata(dataset, name, changes, reason_text, request_key):
	require_admin()
	why = reason(reason_text)
	changes = args(changes)
	if dataset not in ("duties", "visits", "collections", "expenses"):
		frappe.throw("Unsupported correction type.")
	row = locked_record(TABLES[dataset][0], name)
	old = prior(request_key)
	if old:
		return response_audit(old)
	if dataset == "collections" and not row.duty:
		duty = frappe._dict(status="Direct")
	else:
		duty = row if dataset == "duties" else frappe.get_doc("DSR Duty Session", row.duty, for_update=True)
	allowed = {
		"duties": {"vehicle_number", "start_location", "fuel_type", "duty_off_reason"},
		"visits": {"remarks", "dealer_review"},
		"collections": {"remarks", "transaction_reference", "allocations"},
		"expenses": {"remarks"},
	}[dataset]
	if not changes or not set(changes).issubset(allowed):
		frappe.throw(
			"Only eligible metadata can be corrected. Use an audited reversal for amount/payment corrections."
		)
	before = {k: row.get(k) for k in changes}
	if duty.status == "Finalized" or (dataset == "visits" and row.status == "Completed"):
		return response_audit(
			audit(
				"Correction requested (original preserved)",
				row,
				before,
				changes,
				why,
				request_key,
				outcome="Review requested",
			)
		)
	if dataset == "collections" and (row.payment_entry or row.verification_status != "Recorded"):
		frappe.throw(
			"Use the linked ERPNext cancellation/amendment workflow for posted or reversed collections."
		)
	if dataset == "expenses" and row.posting_status == "Reversed":
		frappe.throw("Reversed expenses are immutable.")
	if "vehicle_number" in changes:
		try:
			changes["vehicle_number"] = api.indian_vehicle_number(changes["vehicle_number"])
		except ValueError as error:
			frappe.throw(str(error))
	if "start_location" in changes and changes["start_location"] not in (
		"Home",
		"Current Location",
		"Night Stay",
	):
		frappe.throw("Invalid starting-location label.")
	if "fuel_type" in changes and changes["fuel_type"] not in ("Petrol", "Diesel", "CNG"):
		frappe.throw("Select Petrol, Diesel or CNG.")
	if "duty_off_reason" in changes and (
		not isinstance(changes["duty_off_reason"], str) or len(changes["duty_off_reason"]) > 2000
	):
		frappe.throw("Duty OFF reason must be text up to 2000 characters.")
	if "dealer_review" in changes:
		review = args(changes["dealer_review"])
		if not set(review).issubset(
			{"product", "pricing", "complaints", "service", "suggestions", "remarks"}
		) or any(not isinstance(v, str) or len(v) > 2000 for v in review.values()):
			frappe.throw("Invalid review fields.")
		changes["dealer_review"] = json.dumps(review)
	if "allocations" in changes:
		require_finance()
		changes["allocations"] = validate_allocations(row, changes["allocations"])
	for key, value in changes.items():
		if key in ("remarks", "transaction_reference") and (not isinstance(value, str) or len(value) > 4000):
			frappe.throw("Metadata must be text up to 4000 characters.")
		row.set(key, value)
	api.save(row)
	return response_audit(
		audit("Correct metadata", row, before, {k: row.get(k) for k in changes}, why, request_key)
	)


@frappe.whitelist(methods=["POST"])
def request_field_correction(dataset, name, field, value, reason_text, request_key):
	"""Record a proposed correction without changing original evidence or totals."""
	require_admin()
	if dataset not in TABLES or dataset == "audit":
		frappe.throw("Select a DSR operational record.")
	if not frappe.db.exists(TABLES[dataset][0], {**conditions(dataset, {"all_dates": True}), "name": name}):
		frappe.throw("This record is outside the Smart DSR control panel scope.", frappe.PermissionError)
	row = locked_record(TABLES[dataset][0], name)
	why = reason(reason_text)
	old = prior(request_key)
	if old:
		return response_audit(old)
	blocked = {
		"doctype",
		"name",
		"owner",
		"creation",
		"modified",
		"modified_by",
		"idx",
		"parent",
		"parenttype",
		"parentfield",
		"territory",
		"territories",
		"employee",
		"employee_name",
	}
	if not isinstance(field, str) or field in blocked or field.startswith("_") or field not in row.as_dict():
		frappe.throw("Select an existing operational field.")
	if not isinstance(value, str) or len(value) > 4000 or isinstance(row.get(field), (dict, list)):
		frappe.throw("Enter a correction of up to 4000 characters for a single field.")
	return response_audit(
		audit(
			"Field correction requested",
			row,
			{field: row.get(field)},
			{field: value},
			why,
			request_key,
			outcome="Review requested",
		)
	)


def validate_allocations(row, values):
	values = frappe.parse_json(values) if isinstance(values, str) else values
	if not isinstance(values, list) or len(values) > 100:
		frappe.throw("Invalid allocations.")
	frappe.db.sql("select name from `tabCustomer` where name=%s for update", row.customer)
	result = []
	seen = set()
	for item in sorted(values, key=lambda v: str(v.get("invoice", ""))):
		invoice = frappe.get_doc("Sales Invoice", item.get("invoice"), for_update=True)
		if (
			invoice.name in seen
			or invoice.customer != row.customer
			or invoice.company != api.settings().company
			or invoice.docstatus != 1
		):
			frappe.throw("Invoice must be a unique submitted invoice for this Customer and company.")
		if invoice.currency != frappe.get_cached_value("Company", invoice.company, "default_currency"):
			frappe.throw("Foreign-currency allocations require the Accounts workflow.")
		seen.add(invoice.name)
		value = api.amount(item.get("amount"))
		pending = frappe.db.sql(
			"select allocations from `tabDSR Collection` where customer=%s and verification_status='Recorded' and name!=%s for update",
			(row.customer, row.name),
		)
		reserved = sum(
			flt(a["amount"])
			for p in pending
			for a in json.loads(p[0] or "[]")
			if a["invoice"] == invoice.name
		)
		if api.money(value) > api.money(flt(invoice.outstanding_amount) - reserved):
			frappe.throw("Allocation exceeds unreserved outstanding.")
		result.append({"invoice": invoice.name, "amount": value})
	if api.money(sum(r["amount"] for r in result)) > api.money(row.amount):
		frappe.throw("Allocations exceed the recorded collection.")
	return json.dumps(result)


@frappe.whitelist(methods=["POST"])
def post_payment(collection, reason_text, request_key):
	require_finance()
	why = reason(reason_text)
	row = locked_record("DSR Collection", collection)
	old = prior(request_key)
	if old:
		return response_audit(old)
	before = {"payment_entry": row.payment_entry, "status": row.verification_status}
	name = api.post_collection(collection)
	row.reload()
	return response_audit(
		audit(
			"Post ERPNext payment",
			row,
			before,
			{"payment_entry": name, "status": row.verification_status},
			why,
			request_key,
			("Payment Entry", name),
		)
	)


@frappe.whitelist(methods=["POST"])
def reverse_financial(dataset, name, reason_text, request_key):
	require_finance()
	why = reason(reason_text)
	if dataset not in ("collections", "expenses"):
		frappe.throw("Select a collection or expense.")
	row = locked_record(TABLES[dataset][0], name)
	old = prior(request_key)
	if old:
		return response_audit(old)
	if dataset == "collections" and not row.duty:
		return reverse_direct_collection(row, why, request_key)
	duty = frappe.get_doc("DSR Duty Session", row.duty, for_update=True)
	if duty.status == "Finalized":
		frappe.throw(
			"Finalized balances are immutable. Use Accounts reconciliation and an authorized adjustment in the next open DSR."
		)
	status = "verification_status" if dataset == "collections" else "posting_status"
	if row.get(status) == "Reversed":
		frappe.throw("This record is already reversed.")
	before = {
		"status": row.get(status),
		"cash_balance": api.cash_balance(duty),
		"payment_entry": row.get("payment_entry"),
	}
	if dataset == "collections" and row.payment_entry:
		pe = frappe.get_doc("Payment Entry", row.payment_entry, for_update=True)
		if pe.docstatus == 1:
			pe.check_permission("cancel")
			pe.cancel()
		elif pe.docstatus != 2:
			frappe.throw("Resolve the draft Payment Entry through Accounts first.")
	source = frappe.db.get_value(
		"DSR Cash Ledger",
		{
			"source_type": row.doctype,
			"source_name": row.name,
			"transaction_type": [
				"in",
				[
					"Dealer Cash Collection",
					"Dealer Digital Collection",
					"Dealer Cheque Collection",
					"Cash Expense",
				],
			],
		},
		"name",
	)
	transaction = None
	if source:
		movement = api.cash_movement(duty.name, "Reversal", 0, "admin-reverse:" + request_key, why, source)
		transaction = ("DSR Cash Ledger", movement)
	else:
		if dataset == "collections":
			from srv_erp.overdues import reverse_collection_receipt

			reverse_collection_receipt(row)
		row.set(status, "Reversed")
		api.save(row)
		if row.get("payment_entry"):
			transaction = ("Payment Entry", row.payment_entry)
	duty.reload()
	api.recalculate(duty)
	api.save(duty)
	return response_audit(
		audit(
			"Reverse financial record",
			row,
			before,
			{"status": "Reversed", "cash_balance": duty.closing_balance},
			why,
			request_key,
			transaction,
		)
	)


def reverse_direct_collection(row, why, request_key):
	"""Reverse an account receipt into today's balance, preserving frozen DSRs."""
	from srv_erp.overdues import reverse_collection_receipt

	from .home_collections import collection_context

	if row.verification_status == "Reversed":
		frappe.throw("This record is already reversed.")
	context = collection_context(row.account)
	before = {"status": row.verification_status, "cash_balance": api.cash_balance(context)}
	if row.payment_entry:
		payment = frappe.get_doc("Payment Entry", row.payment_entry, for_update=True)
		if payment.docstatus == 1:
			payment.check_permission("cancel")
			payment.cancel()
		elif payment.docstatus != 2:
			frappe.throw("Resolve the draft Payment Entry through Accounts first.")
	original = frappe.db.get_value(
		"DSR Cash Ledger",
		{
			"account": row.account,
			"source_type": row.doctype,
			"source_name": row.name,
			"transaction_type": [
				"in",
				["Dealer Cash Collection", "Dealer Digital Collection", "Dealer Cheque Collection"],
			],
		},
		"name",
		for_update=True,
	)
	if not original:
		frappe.throw("Collection ledger entry is missing. Reconcile this receipt before reversing it.")
	if frappe.db.exists(
		"DSR Cash Ledger",
		{"source_type": "DSR Cash Ledger", "source_name": original, "transaction_type": "Reversal"},
	):
		frappe.throw("This collection is already reversed.")
	reverse_collection_receipt(row)
	movement = api.ledger(
		context, "Reversal", -row.amount, "DSR Cash Ledger", original, "admin-reverse:" + request_key, why
	)
	row.verification_status = "Reversed"
	api.save(row)
	if context.name:
		api.recalculate(context)
		api.save(context)
	return response_audit(
		audit(
			"Reverse financial record",
			row,
			before,
			{"status": "Reversed", "cash_balance": api.cash_balance(context)},
			why,
			request_key,
			("DSR Cash Ledger", movement.name),
		)
	)


@frappe.whitelist()
def duty_status_requirements(duty, status):
	require_admin()
	if status not in ("Active", "Closed", "Finalized"):
		frappe.throw("Select a valid duty status.")
	if not frappe.db.exists("DSR Duty Session", {**conditions("duties", {"all_dates": True}), "name": duty}):
		frappe.throw("This duty is outside the Smart DSR control panel scope.", frappe.PermissionError)
	from .admin_duty_resolution import requirements

	return requirements(frappe.get_doc("DSR Duty Session", duty), status)


@frappe.whitelist(methods=["POST"])
def change_duty_status(duty, status, request_key, reason_text=None, resolutions=None):
	"""Apply an explicit administrative duty transition; never impersonate device GPS."""
	require_admin()
	doc = locked_record("DSR Duty Session", duty)
	old = prior(request_key)
	if old:
		return response_audit(old)
	why = "Duty status change to " + str(status) + " confirmed in Smart DSR control panel."
	if status not in ("Active", "Closed", "Finalized"):
		frappe.throw("Select a valid duty status.")
	if status == doc.status:
		frappe.throw("Select a different duty status before saving.")
	resolution_values = args(resolutions)
	if status == "Active":
		return dsr_action(duty, "reopen", why, request_key)
	if status == "Finalized":
		if doc.status != "Closed":
			frappe.throw("Close this duty before finalizing it.")
		if resolution_values:
			from .admin_duty_resolution import apply

			apply(doc, resolution_values, request_key)
		from .admin_duty_resolution import requirements

		pending = requirements(doc, status)
		if any(pending.get(group) for group in ("visits", "breaks", "stays", "odometer")):
			frappe.throw("Complete the listed pending details before finalizing this duty.")
		return dsr_action(duty, "finalize", why, request_key)
	if doc.status != "Active":
		frappe.throw("Only an active duty can be closed. Finalized records cannot be changed.")
	if resolution_values:
		from .admin_duty_resolution import apply

		apply(doc, resolution_values, request_key)
	for doctype, filters, message in (
		(
			"DSR Dealer Activity",
			{"duty": duty, "status": "Open"},
			"Complete pending party visits before closing this duty.",
		),
		(
			"DSR Break",
			{"duty": duty, "ended_at": ["is", "not set"]},
			"End the active break before closing this duty.",
		),
		(
			"DSR Night Stay",
			{"duty": duty, "checked_out_at": ["is", "not set"]},
			"Switch Night Stay OFF before closing this duty.",
		),
	):
		if frappe.db.exists(doctype, filters):
			frappe.throw(message)
	visits = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": duty, "status": "Completed"},
		fields=["name", "photo_exception"],
		limit_page_length=0,
	)
	for visit in visits:
		if not visit.photo_exception and not api.valid_photo(visit.name, doc.account):
			frappe.throw("Resolve missing visit evidence before closing this duty.")
	audit_fields = (
		"status",
		"ended_at",
		"closing_balance",
		"gps_status",
		"gps_exception",
		"no_visit_duty",
		"duty_off_reason",
		"odometer_distance",
	)
	before = {key: doc.get(key) for key in audit_fields}
	if doc.get("odometer_required"):
		from .odometer import difference, validate_stored_photo

		validate_stored_photo(doc, "start")
		validate_stored_photo(doc, "end")
		doc.odometer_distance = difference(doc.odometer_start, doc.odometer_end)
	if not visits:
		doc.no_visit_duty = 1
		doc.duty_off_reason = "Duty closed by administrator; no completed dealer visits."
		from .no_visit_duty import reverse_benefits

		reverse_benefits(doc)
	else:
		from .meal_expenses import post_due_meals

		post_due_meals(doc)
	doc.gps_exception = doc.gps_exception or "Administrative Duty OFF without a new device GPS sample."
	doc.ended_at, doc.status, doc.gps_status = now_datetime(), "Closed", "Stopped"
	api.recalculate(doc)
	api.save(doc)
	api.event(doc, "Duty OFF", why)
	return response_audit(
		audit(
			"Change duty status", doc, before, {key: doc.get(key) for key in audit_fields}, why, request_key
		)
	)


@frappe.whitelist(methods=["POST"])
def dsr_action(duty, action, reason_text, request_key):
	require_admin()
	why = reason(reason_text)
	doc = locked_record("DSR Duty Session", duty)
	old = prior(request_key)
	if old:
		return response_audit(old)
	before = {"status": doc.status, "closing_balance": doc.closing_balance, "ended_at": doc.ended_at}
	outcome = "Applied"
	if action == "note":
		pass
	elif action == "request_correction":
		outcome = "Review requested"
	elif action == "recalculate":
		if doc.status == "Finalized":
			frappe.throw("Finalized DSRs are immutable; record a correction request instead.")
		api.recalculate(doc)
		api.save(doc)
	elif action == "finalize":
		require_finance()
		api.finalize_document(doc)
	elif action == "reopen":
		if getdate(doc.work_date) != getdate():
			frappe.throw(
				"Only a same-day closed draft can resume duty. Request a correction for a historical report."
			)
		if doc.status != "Closed" or frappe.db.get_value("DSR", doc.dsr, "docstatus") != 0:
			frappe.throw(
				"Only a closed, unsubmitted DSR can be reopened. Finalized reports require a correction request."
			)
		if frappe.db.exists(
			"DSR Duty Session", {"account": doc.account, "status": "Active", "name": ["!=", doc.name]}
		):
			frappe.throw("This User already has an active duty.")
		if doc.get("no_visit_duty"):
			frappe.throw("No-visit duties cannot be reopened. Start a new DSR instead.")
		doc.status = "Active"
		doc.ended_at = None
		doc.gps_status = "Interrupted"
		doc.gps_interrupted_at = now_datetime()
		api.save(doc)
		api.event(doc, "Exception", "Administrator reopened an unsubmitted duty: " + why)
	else:
		frappe.throw("Unknown administrative action.")
	return response_audit(
		audit(
			action,
			doc,
			before,
			{"status": doc.status, "closing_balance": doc.closing_balance, "ended_at": doc.ended_at},
			why,
			request_key,
			outcome=outcome,
		)
	)


@frappe.whitelist(methods=["POST"])
def link_order(activity, order, reason_text, request_key):
	require_admin()
	why = reason(reason_text)
	visit = locked_record("DSR Dealer Activity", activity)
	old = prior(request_key)
	if old:
		return response_audit(old)
	if visit.status != "Open" or frappe.db.get_value("DSR Duty Session", visit.duty, "status") == "Finalized":
		frappe.throw(
			"Submitted visits need an administrative correction request; original associations remain protected."
		)
	doc = frappe.get_doc("Sales Order", order, for_update=True)
	if (
		doc.docstatus != 1
		or doc.customer != visit.customer
		or doc.company != api.settings().company
		or doc.owner != visit.account
	):
		frappe.throw("Select a submitted order owned by this User for the same dealer/company.")
	if doc.custom_dsr_visit and doc.custom_dsr_visit != visit.name:
		frappe.throw("Order already belongs to another visit.")
	before = doc.custom_dsr_visit
	doc.db_set("custom_dsr_visit", visit.name, update_modified=False)
	return response_audit(
		audit(
			"Link order",
			visit,
			{"order": order, "visit": before},
			{"order": order, "visit": visit.name},
			why,
			request_key,
			("Sales Order", order),
		)
	)


def report_filters(report, filters):
	filters = args(filters).copy()
	periods = {"Daily", "Weekly", "Monthly", "Quarterly"}
	mapping = {
		"Salespersons": "people",
		"Opening Balances": "balances",
		"Vehicles": "vehicles",
		"Duty Records": "duties",
		"Party Visits": "visits",
		"DSR Records": "dsrs",
		"Dealer Visits": "visits",
		"Collections": "collections",
		"Outstanding Dues": "outstanding",
		"Expenses": "expenses",
		"Cash Balances": "balances",
		"GPS Exceptions": "gps",
	}
	if report in periods:
		date = getdate(filters.get("date") or filters.get("to_date") or getdate())
		start = (
			date
			if report == "Daily"
			else date - timedelta(days=date.weekday())
			if report == "Weekly"
			else date.replace(day=1)
			if report == "Monthly"
			else date.replace(month=((date.month - 1) // 3) * 3 + 1, day=1)
		)
		filters["from_date"] = str(start)
		filters["to_date"] = str(date)
		filters.pop("all_dates", None)
		return "duties", filters
	if report not in mapping:
		frappe.throw("Unknown report.")
	if report == "Cash Balances" and not filters.get("all_dates"):
		filters["balance_as_of"] = str(bounds(filters)[1])
	return mapping[report], filters


@frappe.whitelist()
def report(report, filters=None, page=1, page_size=20):
	require_admin()
	dataset, filters = report_filters(report, filters)
	result = list_records(dataset, filters, page, page_size)
	result.update(report=report, dataset=dataset, filters=filters)
	if dataset == "duties":
		result["totals"] = overview(filters)
	return result


@frappe.whitelist()
def export_report(report, filters=None, file_type="xlsx"):
	require_admin()
	if file_type not in ("xlsx", "pdf"):
		frappe.throw("Choose PDF or Excel.")
	dataset, filters = report_filters(report, filters)
	first = list_records(dataset, filters, 1, 100)
	if first["total"] > 5000:
		frappe.throw("Filter the report to 5,000 rows or fewer before exporting.")
	rows = list(first["rows"])
	for page in range(2, (first["total"] + 99) // 100 + 1):
		rows.extend(list_records(dataset, filters, page, 100)["rows"])
	columns = list(rows[0].keys()) if rows else ["name"]

	from .time_format import date_field, display_date, display_duration, duration_field, duration_label

	def cell(key, value):
		if duration_field(key):
			value = display_duration(key, value)
		elif date_field(key):
			value = display_date(key, value)
		if isinstance(value, (dict, list)):
			value = frappe.as_json(value)
		if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
			value = "'" + value
		return value

	matrix = [[duration_label(key) for key in columns]] + [
		[cell(key, row.get(key)) for key in columns] for row in rows
	]
	if file_type == "xlsx":
		from frappe.utils.xlsxutils import make_xlsx

		content = make_xlsx(matrix, "Smart DSR").getvalue()
	else:
		from frappe.utils.pdf import get_pdf

		table = (
			"<table><thead><tr>"
			+ "".join("<th>" + html.escape(str(c)) + "</th>" for c in matrix[0])
			+ "</tr></thead><tbody>"
			+ "".join(
				"<tr>"
				+ "".join("<td>" + html.escape(str(c if c is not None else "")) + "</td>" for c in row)
				+ "</tr>"
				for row in matrix[1:]
			)
			+ "</tbody></table>"
		)
		content = get_pdf(
			'<html><head><meta charset="utf-8"><style>body{font:9px Arial}table{border-collapse:collapse;width:100%}th,td{padding:5px;border:1px solid #ddd;word-break:break-all}</style></head><body><h1>Smart DSR · '
			+ html.escape(report)
			+ "</h1>"
			+ table
			+ "</body></html>",
			{"orientation": "Landscape"},
		)
	frappe.local.response.update(
		filename="smart-dsr-report." + file_type, filecontent=content, type="download"
	)


@frappe.whitelist(methods=["POST"])
def replace_financial(dataset, name, changes, reason_text, request_key):
	require_finance()
	why = reason(reason_text)
	changes = args(changes)
	if dataset not in ("collections", "expenses"):
		frappe.throw("Select a collection or expense.")
	row = locked_record(TABLES[dataset][0], name)
	old = prior(request_key)
	if old:
		return response_audit(old)
	if row.get("verification_status") == "Reversed" or row.get("posting_status") == "Reversed":
		frappe.throw("The original record has already been reversed.")
	if dataset == "collections" and not row.duty:
		from .home_collections import collection_context

		duty = collection_context(row.account)
	else:
		duty = frappe.get_doc("DSR Duty Session", row.duty, for_update=True)
	before = {
		"record": row.name,
		"amount": row.amount,
		"payment_method": row.get("payment_method"),
		"category": row.get("category"),
	}
	# Standard reversal/cancellation and replacement are one database transaction.
	reverse_financial(dataset, name, why, "replace-reversal:" + request_key)
	if dataset == "collections":
		if not set(changes).issubset(
			{"amount", "payment_method", "allocations", "transaction_reference", "remarks"}
		):
			frappe.throw("Invalid collection replacement fields.")
		allocations = changes.get("allocations", row.allocations)
		result = api.collect_payment_document(
			duty,
			row.customer,
			changes.get("amount", row.amount),
			changes.get("payment_method", row.payment_method),
			"replace-collection:" + request_key,
			allocations,
			changes.get("transaction_reference", row.transaction_reference),
			changes.get("remarks", why),
			validate_customer=False,
		)
		replacement = frappe.get_doc("DSR Collection", result["name"])
		replacement.activity = row.activity
		api.save(replacement)
	else:
		if not set(changes).issubset({"amount", "category", "paid_from_cash", "remarks"}):
			frappe.throw("Invalid expense replacement fields.")
		result = api.record_expense_document(
			duty,
			changes.get("category", row.category),
			changes.get("amount", row.amount),
			changes.get("paid_from_cash", row.paid_from_cash),
			"replace-expense:" + request_key,
			changes.get("remarks", why),
			row.receipt,
			receipt_owner=row.account,
		)
		replacement = frappe.get_doc("DSR Expense Record", result["name"])
	if duty.name:
		duty.reload()
		api.recalculate(duty)
		api.save(duty)
	return response_audit(
		audit(
			"Reverse and replace financial record",
			row,
			before,
			{
				"replacement": replacement.name,
				"amount": replacement.amount,
				"closing_balance": api.cash_balance(duty),
			},
			why,
			request_key,
			(replacement.doctype, replacement.name),
		)
	)


@frappe.whitelist(methods=["POST"])
def evidence_exception(duty, reason_text, request_key, activity=None):
	require_admin()
	why = reason(reason_text)
	doc = locked_record("DSR Duty Session", duty)
	old = prior(request_key)
	if old:
		return response_audit(old)
	if doc.status == "Finalized":
		frappe.throw("Finalized evidence is immutable; record a correction request.")
	if activity:
		row = frappe.get_doc("DSR Dealer Activity", activity, for_update=True)
		if row.duty != duty or row.account != doc.account:
			frappe.throw("Visit does not belong to this duty/User.")
		before = {"photo_exception": row.photo_exception}
		row.photo_exception = why
		api.save(row)
		after = {"photo_exception": why}
	else:
		row = doc
		before = {"gps_exception": doc.gps_exception}
		doc.gps_exception = why
		api.save(doc)
		after = {"gps_exception": why}
	api.event(
		doc, "Exception", ("Photo exception for " + activity + ": " if activity else "GPS exception: ") + why
	)
	return response_audit(audit("Authorize evidence exception", row, before, after, why, request_key))


@frappe.whitelist()
def duty_route(duty):
	"""Full route for a duty in the administrator's existing account/report scope."""
	require_admin()
	where = {**conditions("duties", {"all_dates": True}), "name": duty}
	if not frappe.db.exists("DSR Duty Session", where):
		frappe.throw("This duty is outside the Smart DSR control panel scope.", frappe.PermissionError)
	doc = frappe.get_doc("DSR Duty Session", duty)
	point_filters = {
		"duty": doc.name,
		"account": doc.account,
		"captured_at": ["between", [doc.started_at, doc.ended_at or now_datetime()]],
	}
	points = frappe.get_all(
		"DSR GPS Point",
		filters=point_filters,
		fields=["name", "latitude", "longitude", "accuracy", "captured_at", "verified", "rejection_reason"],
		order_by="captured_at asc, name asc",
		limit_page_length=0,
	)
	from .route_map import route_segments

	configuration = api.settings()
	segments, gaps = route_segments(
		points,
		cint(configuration.max_gap_seconds),
		flt(configuration.max_speed_kmh),
		flt(configuration.max_accuracy_m),
	)
	visits = frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": doc.name, "account": doc.account, "status": ["!=", "Deleted"]},
		fields=[
			"name",
			"customer",
			"latitude",
			"longitude",
			"accuracy",
			"arrived_at",
			"departed_at",
			"status",
		],
		order_by="arrived_at asc",
		limit_page_length=0,
	)
	return api.public_dates(
		{
			"duty": doc.name,
			"status": doc.status,
			"account": doc.account,
			"vehicle_number": doc.vehicle_number,
			"points": points,
			"segments": segments,
			"gaps": gaps,
			"visits": visits,
			"verified_km": doc.verified_km,
			"estimated_km": doc.get("estimated_km"),
			"last_sync": doc.last_sync,
		}
	)
