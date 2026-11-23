"""Read-only expense history; expense creation remains in the audited DSR service."""

import frappe
from frappe.utils import cint, getdate

from .api import settings
from .security import account_for


@frappe.whitelist()
def list_expenses(search="", from_date="", to_date="", category="", status="", duty="", start=0):
	user = account_for()
	where, params = ["e.account=%s"], [user]
	if from_date and to_date and getdate(from_date) > getdate(to_date):
		frappe.throw("To Date must be on or after From Date.")
	if from_date:
		where.append("e.recorded_at >= %s")
		params.append(str(getdate(from_date)) + " 00:00:00")
	if to_date:
		from datetime import timedelta

		where.append("e.recorded_at < %s")
		params.append(str(getdate(to_date) + timedelta(days=1)) + " 00:00:00")
	if category:
		where.append("e.category=%s")
		params.append(category)
	if duty:
		where.append("e.duty=%s")
		params.append(duty)
	if status:
		if status not in ("Recorded", "Reversed"):
			frappe.throw("Invalid expense status.")
		where.append("coalesce(e.posting_status,'Recorded')=%s")
		params.append(status)
	if str(search).strip():
		where.append(
			"("
			+ " or ".join(
				f"coalesce({field},'') like %s" for field in ("e.name", "e.category", "e.remarks", "e.duty")
			)
			+ ")"
		)
		params.extend(["%" + str(search).strip()[:100] + "%"] * 4)
	joined = (
		" from `tabDSR Expense Record` e left join `tabDSR Duty Session` d on d.name=e.duty and d.account=e.account where "
		+ " and ".join(where)
	)
	totals = frappe.db.sql(
		"""select count(*) as count,
		coalesce(sum(case when coalesce(e.posting_status,'Recorded')!='Reversed' then e.amount else 0 end),0) as amount,
		coalesce(sum(case when e.posting_status='Reversed' then e.amount else 0 end),0) as reversed_amount
		"""
		+ joined,
		tuple(params),
		as_dict=True,
	)[0]
	rows = frappe.db.sql(
		"select e.name, e.duty, e.category, e.amount, e.recorded_at, e.remarks, e.receipt, e.posting_status, d.work_date, d.status as duty_status"
		+ joined
		+ " order by e.recorded_at desc, e.name desc limit %s offset %s",
		tuple([*params, 50, max(0, cint(start))]),
		as_dict=True,
	)
	categories = frappe.get_all(
		"DSR Expense Record", filters={"account": user}, pluck="category", distinct=True, limit_page_length=0
	)
	return {
		"rows": rows,
		"totals": totals,
		"categories": sorted({value for value in categories if value}),
		"currency": frappe.get_cached_value("Company", settings().company, "default_currency"),
		"page_size": 50,
	}
