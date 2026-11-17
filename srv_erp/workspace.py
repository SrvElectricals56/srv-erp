import json

import frappe


HOME_WORKSPACE_SHORTCUTS = (
	("Item", "DocType", "Item"),
	("Customer", "DocType", "Customer"),
	("Supplier", "DocType", "Supplier"),
	("Sales Order", "DocType", "Sales Order"),
	("Purchase Order", "DocType", "Purchase Order"),
	("Stock Ledger", "Report", "Stock Ledger"),
	("Stock Balance", "Report", "Stock Balance"),
)

HOME_WORKSPACE_REMOVED_SHORTCUTS = {
	"Sales Invoice",
	"Quotation",
	"Lead",
	"Purchase Invoice",
	"Material Request",
	"Stock Dashboard",
}


def ensure_home_workspace_shortcuts():
	"""Add SRV's primary transaction shortcuts to Home without duplicating user content."""
	if not frappe.db.exists("Workspace", "Home"):
		return

	workspace = frappe.get_doc("Workspace", "Home")
	content = frappe.parse_json(workspace.content or "[]")
	if not isinstance(content, list):
		content = []

	changed = False
	for row in list(workspace.shortcuts):
		if row.label in HOME_WORKSPACE_REMOVED_SHORTCUTS:
			workspace.remove(row)
			changed = True

	filtered_content = [
		block
		for block in content
		if not (
			isinstance(block, dict)
			and block.get("type") == "shortcut"
			and block.get("data", {}).get("shortcut_name") in HOME_WORKSPACE_REMOVED_SHORTCUTS
		)
	]
	if len(filtered_content) != len(content):
		content = filtered_content
		changed = True

	existing_rows = {row.label for row in workspace.shortcuts}
	existing_blocks = {
		block.get("data", {}).get("shortcut_name")
		for block in content
		if isinstance(block, dict) and block.get("type") == "shortcut"
	}

	insert_at = next(
		(
			index
			for index, block in enumerate(content)
			if isinstance(block, dict)
			and block.get("data", {}).get("shortcut_name") == "Leaderboard"
		),
		len(content),
	)

	for label, shortcut_type, link_to in HOME_WORKSPACE_SHORTCUTS:
		if label not in existing_rows:
			workspace.append(
				"shortcuts",
				{
					"label": label,
					"type": shortcut_type,
					"link_to": link_to,
				},
			)
			existing_rows.add(label)
			changed = True

		if label not in existing_blocks:
			content.insert(
				insert_at,
				{
					"id": f"srv-home-{frappe.scrub(label)}",
					"type": "shortcut",
					"data": {"shortcut_name": label, "col": 3},
				},
			)
			insert_at += 1
			existing_blocks.add(label)
			changed = True

	if not changed:
		return

	workspace.content = json.dumps(content, separators=(",", ":"))
	was_in_patch = frappe.flags.in_patch
	frappe.flags.in_patch = True
	try:
		workspace.save(ignore_permissions=True)
	finally:
		frappe.flags.in_patch = was_in_patch
	frappe.clear_cache()
