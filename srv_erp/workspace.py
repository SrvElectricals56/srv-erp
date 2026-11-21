import json

import frappe



HOME_WORKSPACE_SECTIONS = (
	(
		"Gateway of ERP",
		(
			("Item", "DocType", "Item"),
			("Customer", "DocType", "Customer"),
			("Supplier", "DocType", "Supplier"),
			("Purchase Order", "DocType", "Purchase Order"),
		),
	),
	(
		"Vouchers",
		(
			("Stock Entry", "DocType", "Stock Entry"),
			("Purchase Receipt", "DocType", "Purchase Receipt"),
			("Sales Order", "DocType", "Sales Order"),
			("Delivery Note", "DocType", "Delivery Note"),
			("DSR", "DocType", "DSR"),
		),
	),
	(
		"Reports & Summary",
		(
			("Stock Balance", "Report", "Stock Balance"),
			("Stock Ledger", "Report", "Stock Ledger"),
			("Items Ordered in Date Range", "Report", "Items Ordered in Date Range"),
			("Items Sold in Date Range", "Report", "Items Sold in Date Range"),
			("Production Planning Forecast", "Report", "Production Planning Forecast"),
			("Daily Outgoing", "Report", "Daily Outgoing"),
		),
	),
)


def _header_block(label, block_id):
	return {
		"id": block_id,
		"type": "header",
		"data": {"text": f'<span class="h4"><b>{label}</b></span>', "col": 12},
	}


def _shortcut_block(label):
	return {
		"id": f"srv-home-{frappe.scrub(label)}",
		"type": "shortcut",
		"data": {"shortcut_name": label, "col": 3},
	}


def get_home_workspace_content():
	"""Return the complete SRV Home layout in native Frappe Workspace block format."""
	content = []
	for section_index, (section_label, shortcuts) in enumerate(HOME_WORKSPACE_SECTIONS, start=1):
		content.append(_header_block(section_label, f"srv-home-section-{section_index}"))
		content.extend(_shortcut_block(label) for label, _shortcut_type, _link_to in shortcuts)
		if section_index < len(HOME_WORKSPACE_SECTIONS):
			content.append(
				{
					"id": f"srv-home-spacer-{section_index}",
					"type": "spacer",
					"data": {"col": 12},
				}
			)
	return content


def ensure_home_workspace_shortcuts():
	"""Replace the visible Home layout with SRV's ERP gateway and verified routes."""
	if not frappe.db.exists("Workspace", "Home"):
		return

	workspace = frappe.get_doc("Workspace", "Home")
	desired_content = get_home_workspace_content()
	desired_shortcuts = [
		(label, shortcut_type, link_to)
		for _section_label, shortcuts in HOME_WORKSPACE_SECTIONS
		for label, shortcut_type, link_to in shortcuts
	]

	current_shortcuts = [(row.label, row.type, row.link_to) for row in workspace.shortcuts]
	current_content = frappe.parse_json(workspace.content or "[]")
	if current_shortcuts == desired_shortcuts and current_content == desired_content:
		return

	workspace.set("shortcuts", [])
	for label, shortcut_type, link_to in desired_shortcuts:
		workspace.append(
			"shortcuts",
			{
				"label": label,
				"type": shortcut_type,
				"link_to": link_to,
			},
		)

	workspace.content = json.dumps(desired_content, separators=(",", ":"))
	was_in_patch = frappe.flags.in_patch
	frappe.flags.in_patch = True
	try:
		workspace.save(ignore_permissions=True)
	finally:
		frappe.flags.in_patch = was_in_patch
	frappe.clear_cache()
