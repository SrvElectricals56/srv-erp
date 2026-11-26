"""Home collections reuse the visit cash ledger and manual overdue receipts."""

import frappe
from frappe.utils import cint, getdate

from . import api
from .home import enabled
from .security import account_for


def collection_context(user):
	"""Use an unfinished duty when present; otherwise record an account receipt."""
	from .cash_allocations import latest_duty

	doc = latest_duty(user, lock=True)
	if doc and doc.status != "Finalized":
		return doc
	return frappe._dict(name=None, account=user, status="Direct")


def account(lock=False):
	if not enabled():
		frappe.throw("Sales Role Profile required.", frappe.PermissionError)
	return account_for(lock=lock)


def assigned_salesperson(user):
	sales = frappe.db.get_value("Sales Person", {"sales_user": user, "enabled": 1}, "name")
	if not sales:
		frappe.throw(
			"Ask Administrator to map your User to an enabled Sales Person before collecting money.",
			frappe.PermissionError,
		)
	return sales


@frappe.whitelist()
@frappe.validate_and_sanitize_search_inputs
def dealer_query(doctype, txt, searchfield, start, page_len, filters):
	sales = assigned_salesperson(account())
	return frappe.get_list(
		"Customer",
		filters={"sales_person": sales, "disabled": 0},
		or_filters={
			field: ["like", "%" + str(txt or "")[:100] + "%"]
			for field in ("name", "customer_name", "mobile_no")
		},
		fields=["name", "customer_name", "mobile_no"],
		as_list=True,
		order_by="customer_name asc, name asc",
		limit_start=max(0, cint(start)),
		limit_page_length=min(50, max(1, cint(page_len))),
	)


@frappe.whitelist()
def options():
	user = account()
	assigned_salesperson(user)
	# A payment form does not need dashboard history, GPS, rewards, or dealer dues.
	duty = frappe.db.get_value("DSR Duty Session", {"account": user, "status": "Active"}, "name")
	return {
		"duty": duty,
		"currency": frappe.get_cached_value("Company", api.settings().company, "default_currency"),
	}


@frappe.whitelist(methods=["POST"])
def collect(customer, value, payment_method, request_key, transaction_reference="", remarks=""):
	user = account(lock=True)
	sales = assigned_salesperson(user)
	dealer = api.dealer(customer)
	if dealer.get("disabled") or dealer.get("sales_person") != sales:
		frappe.throw("Select an enabled dealer or party allocated to you.", frappe.PermissionError)
	prior = api.repeated("DSR Collection", request_key, user)
	if prior:
		if (
			prior.account != user
			or prior.activity
			or prior.customer != customer
			or api.money(prior.amount) != api.money(value)
			or prior.payment_method != payment_method
			or (prior.transaction_reference or "") != (transaction_reference or "")
			or (prior.remarks or "") != (remarks or "")
		):
			frappe.throw("This request identifier belongs to a different collection. Start a new collection.")
		# A retry after Duty OFF returns the original receipt without another cash entry.
		return {"name": prior.name, "balance": api.cash_balance(collection_context(user)), "duplicate": True}
	duty = frappe.db.get_value("DSR Duty Session", {"account": user, "status": "Active"}, "name")
	doc = api.active(duty) if duty else collection_context(user)
	return api.collect_payment_document(
		doc,
		customer,
		value,
		payment_method,
		request_key,
		transaction_reference=transaction_reference,
		remarks=remarks,
	)


@frappe.whitelist()
def collections(
	search="", customer="", from_date="", to_date="", payment_method="", status="", source="", start=0
):
	user = account()
	where, params = ["c.account=%s"], [user]
	for field, value, allowed in (
		("payment_method", payment_method, ("Cash", "UPI", "Bank Transfer", "Cheque")),
		("verification_status", status, ("Recorded", "Posted", "Reversed")),
	):
		if value:
			if value not in allowed:
				frappe.throw("Invalid collection filter.")
			where.append(f"c.{field}=%s")
			params.append(value)
	if from_date and to_date and getdate(from_date) > getdate(to_date):
		frappe.throw("To Date must be on or after From Date.")
	if from_date:
		where.append("c.collected_at >= %s")
		params.append(str(getdate(from_date)) + " 00:00:00")
	if to_date:
		from datetime import timedelta

		where.append("c.collected_at < %s")
		params.append(str(getdate(to_date) + timedelta(days=1)) + " 00:00:00")
	if customer:
		where.append("c.customer=%s")
		params.append(customer)
	if source:
		if source not in ("home", "visit"):
			frappe.throw("Invalid collection source.")
		where.append("coalesce(c.activity,'')" + ("=''" if source == "home" else "!=''"))
	if str(search).strip():
		where.append(
			"("
			+ " or ".join(
				f"coalesce({field},'') like %s"
				for field in (
					"c.name",
					"c.customer",
					"party.customer_name",
					"c.transaction_reference",
					"c.remarks",
					"c.duty",
				)
			)
			+ ")"
		)
		params.extend(["%" + str(search).strip()[:100] + "%"] * 6)
	joined = (
		" from `tabDSR Collection` c left join `tabCustomer` party on party.name=c.customer where "
		+ " and ".join(where)
	)
	totals = frappe.db.sql(
		"""select count(*) as count,
		coalesce(sum(case when c.verification_status!='Reversed' then c.amount else 0 end),0) as total,
		coalesce(sum(case when c.verification_status!='Reversed' and c.payment_method='Cash' then c.amount else 0 end),0) as cash,
		coalesce(sum(case when c.verification_status!='Reversed' and c.payment_method!='Cash' then c.amount else 0 end),0) as noncash
		"""
		+ joined,
		tuple(params),
		as_dict=True,
	)[0]
	rows = frappe.db.sql(
		"select c.name, c.customer, party.customer_name, c.amount, c.payment_method, c.transaction_reference, c.collected_at, c.verification_status, c.remarks, c.duty, c.activity, c.payment_entry"
		+ joined
		+ " order by c.collected_at desc, c.name desc limit %s offset %s",
		tuple([*params, 50, max(0, cint(start))]),
		as_dict=True,
	)
	currency = frappe.get_cached_value("Company", api.settings().company, "default_currency")
	return {"rows": rows, "totals": totals, "currency": currency, "page_size": 50}
