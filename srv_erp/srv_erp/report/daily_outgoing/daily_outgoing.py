# Copyright (c) 2026, SRV Electricals and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.utils import getdate


def execute(filters=None):
	filters = frappe._dict(filters or {})
	validate_filters(filters)
	return get_columns(), get_data(filters)


def validate_filters(filters):
	if not filters.get("company"):
		frappe.throw(_("Company is required."))
	if not filters.get("from_date") or not filters.get("to_date"):
		frappe.throw(_("From Date and To Date are required."))
	if getdate(filters.from_date) > getdate(filters.to_date):
		frappe.throw(_("From Date cannot be after To Date."))


def get_columns():
	return [
		{"label": _("Posting Date"), "fieldname": "posting_date", "fieldtype": "Date", "width": 110},
		{
			"label": _("Item Code"),
			"fieldname": "item_code",
			"fieldtype": "Link",
			"options": "Item",
			"width": 150,
		},
		{"label": _("Item Name"), "fieldname": "item_name", "fieldtype": "Data", "width": 220},
		{
			"label": _("Warehouse"),
			"fieldname": "warehouse",
			"fieldtype": "Link",
			"options": "Warehouse",
			"width": 180,
		},
		{
			"label": _("Outgoing Qty"),
			"fieldname": "outgoing_qty",
			"fieldtype": "Float",
			"width": 125,
		},
		{
			"label": _("Stock UOM"),
			"fieldname": "stock_uom",
			"fieldtype": "Link",
			"options": "UOM",
			"width": 100,
		},
		{
			"label": _("Outgoing Value"),
			"fieldname": "outgoing_value",
			"fieldtype": "Currency",
			"options": "currency",
			"width": 140,
		},
		{"label": _("Voucher Count"), "fieldname": "voucher_count", "fieldtype": "Int", "width": 115},
		{
			"label": _("Company"),
			"fieldname": "company",
			"fieldtype": "Link",
			"options": "Company",
			"hidden": 1,
		},
		{
			"label": _("Currency"),
			"fieldname": "currency",
			"fieldtype": "Link",
			"options": "Currency",
			"hidden": 1,
		},
	]


def get_data(filters):
	conditions = [
		"sle.is_cancelled = 0",
		"sle.actual_qty < 0",
		"sle.company = %(company)s",
		"sle.posting_date BETWEEN %(from_date)s AND %(to_date)s",
	]
	if filters.get("warehouse"):
		conditions.append("sle.warehouse = %(warehouse)s")
	if filters.get("item_code"):
		conditions.append("sle.item_code = %(item_code)s")
	if filters.get("item_group"):
		conditions.append("item.item_group = %(item_group)s")

	return frappe.db.sql(
		f"""
			SELECT
				sle.posting_date,
				sle.item_code,
				item.item_name,
				sle.warehouse,
				item.stock_uom,
				SUM(ABS(sle.actual_qty)) AS outgoing_qty,
				SUM(ABS(sle.stock_value_difference)) AS outgoing_value,
				COUNT(DISTINCT CONCAT(sle.voucher_type, ':', sle.voucher_no)) AS voucher_count,
				sle.company,
				company.default_currency AS currency
			FROM `tabStock Ledger Entry` sle
			INNER JOIN `tabItem` item ON item.name = sle.item_code
			INNER JOIN `tabCompany` company ON company.name = sle.company
			WHERE {' AND '.join(conditions)}
			GROUP BY
				sle.posting_date,
				sle.item_code,
				item.item_name,
				sle.warehouse,
				item.stock_uom,
				sle.company,
				company.default_currency
			ORDER BY sle.posting_date DESC, sle.item_code, sle.warehouse
		""",
		filters,
		as_dict=True,
	)
