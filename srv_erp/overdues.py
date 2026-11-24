"""Permission-scoped, manual dealer overdue register. No accounting imports or writes."""

import frappe
from frappe import _
from frappe.utils import flt, get_datetime, getdate, nowdate

DOCTYPE = "Dealer Overdue"


def company_name():
	company = frappe.db.get_value("Company", {"company_name": "SRV Electricals"}, "name")
	if not company:
		frappe.throw(_("SRV Electricals company was not found."))
	return company


def require_access(ptype="read"):
	if frappe.session.user == "Guest" or not frappe.has_permission(DOCTYPE, ptype):
		frappe.throw(
			_("You do not have permission to access manual dealer overdues."), frappe.PermissionError
		)


@frappe.whitelist()
def get_dealer_details(customer):
	require_access()
	if not (
		frappe.has_permission("Customer", "read", doc=customer)
		or frappe.has_permission("Customer", "select", doc=customer)
	):
		frappe.throw(_("You do not have permission to access this dealer."), frappe.PermissionError)
	return frappe.db.get_value("Customer", customer, ["sales_person", "territory"], as_dict=True) or {}


@frappe.whitelist()
def get_entry_options():
	require_access("create")
	company = company_name()
	return {"company": company, "currency": frappe.get_cached_value("Company", company, "default_currency")}


@frappe.whitelist()
def get_overdues(report_date=None, customer=None, territory=None, sales_person=None):
	require_access()
	try:
		as_of = getdate(report_date or nowdate())
	except (ValueError, TypeError):
		frappe.throw(_("Enter a valid ageing date."))
	if as_of is None:
		frappe.throw(_("Enter a valid ageing date."))
	if as_of > getdate(nowdate()):
		frappe.throw(_("Ageing Date cannot be in the future."))
	company = company_name()
	filters = {"company": company, "state": "Active", "entry_date": ["<=", str(as_of)]}
	for field, value in (("customer", customer), ("territory", territory), ("sales_person", sales_person)):
		if value:
			filters[field] = value
	# get_list enforces DocType roles and linked-document user permissions.
	entries = frappe.get_list(
		DOCTYPE,
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"territory",
			"sales_person",
			"entry_date",
			"due_date",
			"reference_no",
			"amount",
			"amount_received",
			"outstanding_amount",
			"remarks",
		],
		order_by="due_date asc, creation desc",
		limit_page_length=0,
	)
	return {
		"rows": normalize_rows(entries, as_of),
		"company": company,
		"report_date": str(as_of),
		"currency": frappe.get_cached_value("Company", company, "default_currency"),
		"can_create": bool(frappe.has_permission(DOCTYPE, "create")),
		"can_receive": bool(
			frappe.has_permission(DOCTYPE, "write")
			and frappe.has_permission("Dealer Overdue Receipt", "create")
		),
		"can_export": bool(frappe.has_permission(DOCTYPE, "export")),
		"can_print": bool(frappe.has_permission(DOCTYPE, "print")),
		"generated_at": frappe.utils.now(),
	}


@frappe.whitelist(methods=["POST"])
def create_overdue(values, request_key):
	require_access("create")
	if not isinstance(request_key, str) or not request_key.strip() or len(request_key) > 140:
		frappe.throw(_("A valid request key is required."))
	prior = frappe.db.get_value(DOCTYPE, {"request_key": request_key}, "name")
	if prior:
		frappe.get_doc(DOCTYPE, prior).check_permission("read")
		return prior
	values = frappe.parse_json(values) if isinstance(values, str) else values
	if not isinstance(values, dict):
		frappe.throw(_("Enter overdue details."))
	allowed = (
		"customer",
		"entry_date",
		"due_date",
		"reference_no",
		"sales_person",
		"amount",
		"amount_received",
		"remarks",
	)
	doc = frappe.get_doc(
		{
			"doctype": DOCTYPE,
			"state": "Active",
			"request_key": request_key,
			**{key: values.get(key) for key in allowed if key in values},
		}
	)
	try:
		doc.insert()
	except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
		prior = frappe.db.get_value(DOCTYPE, {"request_key": request_key}, "name", for_update=True)
		if not prior:
			raise
		frappe.get_doc(DOCTYPE, prior).check_permission("read")
		return prior
	return doc.name


def normalize_rows(source, as_of):
	rows = []
	for item in source:
		row = frappe._dict(item)
		amount, paid = flt(row.amount), flt(row.amount_received)
		balance = flt(row.outstanding_amount)
		due = getdate(row.due_date)
		days = max(0, (getdate(as_of) - due).days)
		rows.append(
			{
				"customer": row.customer,
				"customer_name": row.customer_name or row.customer,
				"territory": row.territory or "",
				"sales_person": row.sales_person or "",
				"voucher_type": DOCTYPE,
				"voucher_no": row.name,
				"reference_no": row.reference_no or "",
				"posting_date": str(getdate(row.entry_date)),
				"due_date": str(due),
				"days_overdue": days,
				"amount": amount,
				"paid": paid,
				"outstanding": balance,
				"overdue": balance if balance > 0 and days > 0 else 0,
				"remarks": row.remarks or "",
			}
		)
	return sorted(rows, key=lambda row: (-row["days_overdue"], row["customer"], row["voucher_no"]))


@frappe.whitelist(methods=["POST"])
def record_received_amount(customer, amount, received_date, request_key, reference_no=None, remarks=None):
	require_access("write")
	if not frappe.has_permission("Dealer Overdue Receipt", "create"):
		frappe.throw(_("You do not have permission to record received amounts."), frappe.PermissionError)
	get_dealer_details(customer)
	if not isinstance(request_key, str) or not request_key.strip() or len(request_key) > 140:
		frappe.throw(_("A valid request key is required."))
	# Serialize receipts for this dealer, including retries of the same request.
	frappe.db.get_value("Customer", customer, "name", for_update=True)
	prior = frappe.db.get_value(
		"Dealer Overdue Receipt", {"request_key": request_key}, "name", for_update=True
	)
	if prior:
		doc = frappe.get_doc("Dealer Overdue Receipt", prior)
		doc.check_permission("read")
		if doc.customer != customer:
			frappe.throw(_("Receipt belongs to a different dealer."), frappe.PermissionError)
		return doc.name
	doc = frappe.get_doc(
		{
			"doctype": "Dealer Overdue Receipt",
			"customer": customer,
			"amount": amount,
			"received_date": received_date,
			"request_key": request_key,
			"reference_no": reference_no,
			"remarks": remarks,
		}
	)
	doc.insert()
	return doc.name


def apply_received_amount(receipt):
	"""Apply a new manual receipt to the oldest permitted unpaid entries atomically."""
	from decimal import Decimal
	from math import isfinite

	collection = validate_collection_receipt(receipt) if receipt.get("dsr_collection") else None
	if not collection:
		require_access("write")
		get_dealer_details(receipt.customer)
	frappe.db.get_value("Customer", receipt.customer, "name", for_update=True)
	receipt.currency = frappe.get_cached_value("Company", company_name(), "default_currency")
	try:
		amount = float(receipt.amount)
	except (TypeError, ValueError, OverflowError):
		frappe.throw(_("Enter a valid received amount."))
	if not isfinite(amount) or amount <= 0:
		frappe.throw(_("Received Amount must be greater than zero and finite."))
	receipt.amount = flt(amount, receipt.precision("amount"))
	if receipt.amount <= 0:
		frappe.throw(_("Received Amount is below the currency precision."))
	receipt.received_date = getdate(receipt.received_date or nowdate())
	if receipt.received_date is None or receipt.received_date > getdate(nowdate()):
		frappe.throw(_("Enter a valid Received Date on or before today."))
	filters = {
		"company": company_name(),
		"customer": receipt.customer,
		"state": "Active",
		"entry_date": ["<=", str(receipt.received_date)],
		"outstanding_amount": [">", 0],
	}
	if collection:
		filters["creation"] = ["<=", collection.collected_at]
	query = frappe.get_all if collection else frappe.get_list
	names = query(
		DOCTYPE,
		filters=filters,
		pluck="name",
		order_by="due_date asc, creation asc, name asc",
		limit_page_length=0,
	)
	documents = []
	for name in names:
		doc = frappe.get_doc(DOCTYPE, name, for_update=True)
		if not collection:
			doc.check_permission("write")
		if (
			doc.state == "Active"
			and doc.customer == receipt.customer
			and doc.company == company_name()
			and getdate(doc.entry_date) <= receipt.received_date
			and doc.outstanding_amount > 0
		):
			documents.append(doc)
	remaining = Decimal(str(receipt.amount))
	total = sum((Decimal(str(doc.outstanding_amount)) for doc in documents), Decimal(0))
	if remaining > total and not collection:
		frappe.throw(_("Received Amount exceeds this dealer's remaining balance of {0}.").format(total))
	receipt.dues_amount = float(total)
	receipt.leftover_dues = float(max(total - remaining, Decimal(0)))
	receipt.balance_snapshot_available = 1
	receipt.applied_amount = float(min(remaining, total))
	receipt.unapplied_amount = float(max(remaining - total, Decimal(0)))
	remaining = min(remaining, total)
	allocations = []
	for doc in documents:
		if remaining <= 0:
			break
		allocated = min(remaining, Decimal(str(doc.outstanding_amount)))
		doc.amount_received = float(Decimal(str(doc.amount_received or 0)) + allocated)
		doc.save(ignore_permissions=bool(collection))
		allocations.append({"entry": doc.name, "amount": float(allocated)})
		remaining -= allocated
	receipt.allocations = frappe.as_json(allocations)


def validate_collection_receipt(receipt):
	"""Allow scoped DSR collections to update dues without granting accounting roles."""
	from srv_erp.smart_dsr import api
	from srv_erp.smart_dsr.admin_permissions import is_admin

	collection = frappe.get_doc("DSR Collection", receipt.dsr_collection)
	if not is_admin():
		if api.identity() != collection.account:
			frappe.throw(_("This collection belongs to a different user."), frappe.PermissionError)
		api.dealer(collection.customer)
	else:
		frappe.get_doc("Customer", collection.customer).check_permission("read")
	if collection.verification_status == "Reversed":
		frappe.throw(_("A reversed collection cannot reduce overdue balances."))
	if (
		receipt.customer != collection.customer
		or flt(receipt.amount) != flt(collection.amount)
		or getdate(receipt.received_date) != getdate(collection.collected_at)
	):
		frappe.throw(_("Receipt details must match the Smart DSR collection."))
	if api.settings().company != company_name():
		frappe.throw(_("The collection company does not match the overdue register."))
	return collection


def sync_collection_receipt(collection):
	"""Create one manual-register receipt for an authenticated recorded DSR collection."""
	if collection.verification_status == "Reversed":
		return None
	frappe.db.get_value("Customer", collection.customer, "name", for_update=True)
	prior = frappe.db.get_value(
		"Dealer Overdue Receipt", {"dsr_collection": collection.name}, "name", for_update=True
	)
	if prior:
		return prior
	receipt = frappe.get_doc(
		{
			"doctype": "Dealer Overdue Receipt",
			"customer": collection.customer,
			"amount": collection.amount,
			"received_date": getdate(collection.collected_at),
			"reference_no": collection.transaction_reference or collection.name,
			"remarks": _("Collected through Smart DSR via {0}.").format(collection.payment_method),
			"request_key": "dsr-collection:" + collection.name,
			"dsr_collection": collection.name,
		}
	)
	validate_collection_receipt(receipt)
	receipt.insert(ignore_permissions=True)
	return receipt.name


def reverse_collection_receipt(collection):
	"""Restore the original allocations when the corresponding collection is reversed."""
	from decimal import Decimal

	from srv_erp.smart_dsr.admin_permissions import require_admin

	require_admin()
	frappe.db.get_value("Customer", collection.customer, "name", for_update=True)
	name = frappe.db.get_value(
		"Dealer Overdue Receipt", {"dsr_collection": collection.name}, "name", for_update=True
	)
	if not name:
		return
	receipt = frappe.get_doc("Dealer Overdue Receipt", name, for_update=True)
	if receipt.reversed:
		return
	for allocation in frappe.parse_json(receipt.allocations or "[]"):
		doc = frappe.get_doc(DOCTYPE, allocation["entry"], for_update=True)
		updated = Decimal(str(doc.amount_received or 0)) - Decimal(str(allocation["amount"]))
		if updated < 0:
			frappe.throw(
				_("Reconcile manual received amounts on {0} before reversing this collection.").format(
					doc.name
				)
			)
		doc.amount_received = float(updated)
		doc.save(ignore_permissions=True)
	receipt.db_set("reversed", 1)


def sync_existing_dsr_collections():
	"""Backfill collections recorded after the manual register began, once per source."""
	from srv_erp.smart_dsr.admin_permissions import require_admin

	require_admin()
	first = frappe.db.get_value(DOCTYPE, {"company": company_name()}, "min(creation)")
	if not first:
		return {"created": 0}
	names = frappe.get_all(
		"DSR Collection",
		filters={"verification_status": ["!=", "Reversed"], "collected_at": [">=", first]},
		pluck="name",
		order_by="collected_at asc, creation asc",
		limit_page_length=0,
	)
	created = 0
	applied = 0
	unapplied = 0
	for name in names:
		if frappe.db.exists("Dealer Overdue Receipt", {"dsr_collection": name}):
			continue
		collection = frappe.get_doc("DSR Collection", name)
		receipt_name = sync_collection_receipt(collection)
		receipt = frappe.get_doc("Dealer Overdue Receipt", receipt_name)
		applied += flt(receipt.applied_amount)
		unapplied += flt(receipt.unapplied_amount)
		created += 1
	return {"created": created, "applied": applied, "unapplied": unapplied}


def backfill_receipt_balance_snapshots():
	"""Recover prior receipt balances from the tracked overdue record versions."""
	from decimal import Decimal

	from srv_erp.smart_dsr.admin_permissions import require_admin

	require_admin()
	receipts = frappe.get_all(
		"Dealer Overdue Receipt",
		filters={"balance_snapshot_available": 0},
		fields=["name", "customer", "creation", "received_date", "amount", "allocations", "dsr_collection"],
		limit_page_length=0,
	)
	import re
	from html import unescape

	from frappe.utils import strip_html
	from frappe.utils.data import get_number_format_info

	number_format = frappe.db.get_single_value("System Settings", "number_format") or "#,###.##"
	decimal_separator, thousands_separator, _precision = get_number_format_info(number_format)
	date_format = frappe.db.get_single_value("System Settings", "date_format") or "yyyy-mm-dd"
	recovered = 0
	for receipt in receipts:
		cutoff = get_datetime(receipt.creation)
		entries = frappe.get_all(
			DOCTYPE,
			filters={"creation": ["<=", cutoff]},
			fields=[
				"name",
				"customer",
				"company",
				"creation",
				"entry_date",
				"state",
				"amount",
				"amount_received",
			],
			limit_page_length=0,
		)
		by_name = {entry.name: entry for entry in entries}
		allocations = frappe.parse_json(receipt.allocations or "[]")
		if any(allocation["entry"] not in by_name for allocation in allocations):
			continue
		versions = frappe.get_all(
			"Version",
			filters={"ref_doctype": DOCTYPE, "creation": [">=", cutoff]},
			fields=["docname", "data"],
			order_by="creation desc, name desc",
			limit_page_length=0,
		)
		# A receipt's creation timestamp precedes the updates made by its allocation.
		for version in versions:
			entry = by_name.get(version.docname)
			if entry:
				for field, before, _after in frappe.parse_json(version.data or "{}").get("changed", []):
					if isinstance(before, str):
						before = unescape(strip_html(before))
						if field in ("amount", "amount_received"):
							before = re.sub(r"[^0-9.,+-]", "", before)
							if thousands_separator:
								before = before.replace(thousands_separator, "")
							before = Decimal(before.replace(decimal_separator, ".") or "0")
						elif field == "entry_date":
							before = getdate(before, parse_day_first=date_format.startswith("dd"))
					entry[field] = before
		collection_cutoff = (
			frappe.db.get_value("DSR Collection", receipt.dsr_collection, "collected_at")
			if receipt.dsr_collection
			else None
		)
		total = Decimal(0)
		for entry in entries:
			if (
				entry.customer == receipt.customer
				and entry.company == company_name()
				and entry.state == "Active"
				and getdate(entry.entry_date) <= getdate(receipt.received_date)
				and (not collection_cutoff or get_datetime(entry.creation) <= get_datetime(collection_cutoff))
			):
				total += max(
					Decimal(str(entry.amount or 0)) - Decimal(str(entry.amount_received or 0)), Decimal(0)
				)
		frappe.db.set_value(
			"Dealer Overdue Receipt",
			receipt.name,
			{
				"dues_amount": float(total),
				"leftover_dues": float(max(total - Decimal(str(receipt.amount)), Decimal(0))),
				"balance_snapshot_available": 1,
			},
			update_modified=False,
		)
		recovered += 1
	return {"recovered": recovered, "unavailable": len(receipts) - recovered}
