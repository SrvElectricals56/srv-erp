"""End zero-visit duty without benefits, preserving expenses and cash reversal evidence."""

import frappe
from frappe.utils import flt


def validate_reason(reason):
	if not isinstance(reason, str) or not reason.strip():
		frappe.throw("A Duty OFF reason is required because no dealer visits were completed.")
	reason = reason.strip()
	if len(reason) > 2000:
		frappe.throw("Keep the Duty OFF reason within 2,000 characters.")
	return reason


def reverse_benefits(doc):
	"""Caller holds the User and duty locks; reversal keys make retries safe."""
	from . import api

	remarks = "No-visit duty: benefits reversed. Reason: " + doc.duty_off_reason
	expenses = frappe.get_all(
		"DSR Expense Record",
		filters={"duty": doc.name, "account": doc.account, "posting_status": ["!=", "Reversed"]},
		pluck="name",
		limit_page_length=0,
	)
	for name in expenses:
		expense = frappe.get_doc("DSR Expense Record", name, for_update=True)
		for movement in frappe.get_all(
			"DSR Cash Ledger",
			filters={
				"duty": doc.name,
				"account": doc.account,
				"source_type": "DSR Expense Record",
				"source_name": name,
				"transaction_type": "Cash Expense",
			},
			fields=["name", "amount"],
			limit_page_length=0,
		):
			if not frappe.db.exists(
				"DSR Cash Ledger",
				{
					"source_type": "DSR Cash Ledger",
					"source_name": movement.name,
					"transaction_type": "Reversal",
				},
			):
				api.ledger(
					doc,
					"Reversal",
					-flt(movement.amount),
					"DSR Cash Ledger",
					movement.name,
					"no-visit-reversal:" + movement.name,
					remarks,
				)
		expense.posting_status = "Reversed"
		api.save(expense)
	for name in frappe.get_all(
		"DSR Break",
		filters={"duty": doc.name, "account": doc.account, "allowance": ["!=", 0]},
		pluck="name",
		limit_page_length=0,
	):
		row = frappe.get_doc("DSR Break", name, for_update=True)
		before = row.allowance
		row.allowance = 0
		api.save(row)
		api.event(doc, "Exception", f"No-visit duty: reversed legacy meal allowance {before} on {name}.")
	doc.fuel_reimbursement = doc.meal_allowance = 0
	api.event(doc, "Exception", remarks)
