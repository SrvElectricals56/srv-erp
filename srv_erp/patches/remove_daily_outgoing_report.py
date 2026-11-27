"""Remove the retired Daily Outgoing report metadata."""

import frappe


REPORT_NAME = "Daily Outgoing"


def execute():
	if frappe.db.exists("Report", REPORT_NAME):
		frappe.delete_doc(
			"Report",
			REPORT_NAME,
			force=True,
			ignore_permissions=True,
		)

	frappe.clear_cache()
