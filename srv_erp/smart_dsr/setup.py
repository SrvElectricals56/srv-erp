import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
	frappe.reload_doc("srv_erp", "doctype", "dsr_cash_ledger", force=True)
	setup_automatic_meal_expenses()
	setup_administrator_panel()
	migrate_user_accounts()
	create_custom_fields(
		{
			"DSR": [
				{
					"fieldname": "balance_rules_version",
					"label": "Balance Rules Version",
					"fieldtype": "Int",
					"default": "0",
					"hidden": 1,
					"read_only": 1,
				},
				{
					"fieldname": "smart_dsr",
					"label": "Smart DSR",
					"fieldtype": "Check",
					"hidden": 1,
					"read_only": 1,
					"default": "0",
				},
				{
					"fieldname": "smart_duty",
					"label": "Smart Duty",
					"fieldtype": "Link",
					"options": "DSR Duty Session",
					"read_only": 1,
				},
			]
		},
		update=True,
	)
	for dt, fields in (
		("DSR GPS Point", ["duty", "captured_at"]),
		("DSR Cash Ledger", ["employee", "duty"]),
		("DSR Dealer Activity", ["duty", "status"]),
		("DSR Tracking Event", ["duty", "recorded_at"]),
		("DSR Duty Session", ["employee", "work_date"]),
	):
		frappe.db.add_index(dt, fields, "smart_dsr_" + "_".join(fields))
	# Additive only: no historical readings, lead rows, or balances are rewritten.
	# Materialize Single defaults before any operational APIs read them.
	stored = {
		row[0] for row in frappe.db.sql("select field from `tabSingles` where doctype=%s", ("DSR Settings",))
	}
	for field in frappe.get_meta("DSR Settings").fields:
		if field.default is not None and field.fieldname not in stored:
			frappe.db.set_single_value("DSR Settings", field.fieldname, field.default)
	create_custom_fields(
		{
			"Sales Order": [
				{
					"fieldname": "custom_dsr_visit",
					"label": "DSR Party Visit",
					"fieldtype": "Link",
					"options": "DSR Dealer Activity",
					"read_only": 1,
					"no_copy": 1,
					"allow_on_submit": 1,
				}
			]
		},
		update=True,
	)


def migrate_user_accounts():
	"""Add User ownership without dropping or rewriting historical Employee evidence."""
	import json
	from pathlib import Path

	types = []
	root = Path(__file__).resolve().parents[1] / "srv_erp" / "doctype"
	for path in root.glob("dsr_*/*.json"):
		definition = json.loads(path.read_text())
		if any(
			f.get("fieldname") == "account" and f.get("options") == "User"
			for f in definition.get("fields", [])
		):
			frappe.reload_doc("srv_erp", "doctype", path.parent.name)
			types.append(definition["name"])
	return backfill_user_accounts(types)


def backfill_user_accounts(types):
	unresolved = []
	for dt in types:
		# Copy the prior explicit Employee->User relation only. Unlinked records stay
		# Administrator-readable; do not guess ownership from a current browser login.
		frappe.db.sql(f"""update `tab{dt}` d inner join `tabEmployee` e on e.name=d.employee
			inner join `tabUser` u on u.name=e.user_id
			set d.account=u.name where (d.account is null or d.account='')""")
		if frappe.get_meta(dt).has_field("duty"):
			frappe.db.sql(f"""update `tab{dt}` d inner join `tabDSR Duty Session` p on p.name=d.duty
				set d.account=p.account where (d.account is null or d.account='') and p.account is not null""")
		frappe.db.add_index(dt, ["account"], "smart_dsr_user_account")
		count = frappe.db.count(dt, {"account": ["is", "not set"]})
		if count:
			unresolved.append({"doctype": dt, "historical_unmapped_rows": count})
	return {"user_owned_doctypes": len(types), "unresolved": unresolved}


def setup_administrator_panel():
	from .admin_permissions import ADMIN_ROLE, FINANCE_ROLE

	for role in {ADMIN_ROLE, FINANCE_ROLE, "Sales Person"}:
		if not frappe.db.exists("Role", role):
			frappe.get_doc({"doctype": "Role", "role_name": role, "desk_access": 1}).insert(
				ignore_permissions=True
			)
	frappe.reload_doc("srv_erp", "doctype", "dsr_admin_audit")
	frappe.reload_doc("srv_erp", "doctype", "dsr_dealer_activity")
	frappe.reload_doc("srv_erp", "doctype", "dsr_duty_session")
	frappe.reload_doc("srv_erp", "doctype", "dsr_night_stay")
	setup_vehicle_fields()
	create_custom_fields(
		{
			"User": [
				{
					"fieldname": "smart_dsr_disabled",
					"label": "Smart DSR Access Deactivated",
					"fieldtype": "Check",
					"default": "0",
					"read_only": 1,
					"no_copy": 1,
				}
			]
		},
		update=True,
	)
	frappe.db.add_index("DSR Admin Audit", ["record_type", "record_id"], "smart_dsr_audit_record")
	frappe.db.add_index("DSR Admin Audit", ["recorded_at"], "smart_dsr_audit_time")


def setup_vehicle_fields():
	"""Add availability checks once, preserving existing vehicle document information."""
	legacy = {
		"insurance_available": "insurance_number",
		"puc_available": "puc_number",
		"rc_available": "rc_number",
		"fastag_available": "fastag_details",
	}
	new_fields = [field for field in legacy if not frappe.db.has_column("DSR Vehicle", field)]
	frappe.reload_doc("srv_erp", "doctype", "dsr_vehicle")
	for field in new_fields:
		frappe.db.sql(
			f"UPDATE `tabDSR Vehicle` SET `{field}` = CASE WHEN COALESCE(`{legacy[field]}`, '') != '' THEN 1 ELSE 0 END"
		)


def setup_automatic_meal_expenses():
	from datetime import datetime
	from zoneinfo import ZoneInfo

	frappe.reload_doc("srv_erp", "doctype", "dsr_expense_record")
	frappe.reload_doc("srv_erp", "doctype", "dsr_settings")
	enabled_from = frappe.db.get_single_value("DSR Settings", "automatic_meal_expenses_from")
	if not enabled_from or str(enabled_from) == "0001-01-01":
		frappe.db.set_single_value(
			"DSR Settings",
			"automatic_meal_expenses_from",
			datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat(),
		)
