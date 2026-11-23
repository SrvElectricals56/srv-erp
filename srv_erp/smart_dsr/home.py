"""Salesperson Desk home, without changing shared Workspace documents."""

import frappe
from frappe.utils import flt


def enabled(user=None):
	user = user or frappe.session.user
	if user in ("Guest", "Administrator"):
		return False
	return frappe.db.get_value("User", user, "role_profile_name") == "Sales"


def boot_session(bootinfo):
	bootinfo.salesperson_home = enabled()
	if bootinfo.salesperson_home:
		bootinfo.home_page = "Workspaces"
		bootinfo.user.default_workspace = frappe._dict(name="Home", title="Home", public=1)
		if not any(row.get("name") == "Home" for row in bootinfo.allowed_workspaces):
			bootinfo.allowed_workspaces.append(frappe._dict(name="Home", title="Home", public=1))


@frappe.whitelist()
def dealer_top_items(customer):
	"""Rank submitted order quantities using only orders this user may read."""
	if not enabled():
		frappe.throw("Sales Role Profile required.", frappe.PermissionError)
	frappe.get_doc("Customer", customer).check_permission("read")
	orders = frappe.get_list(
		"Sales Order", filters={"customer": customer, "docstatus": 1}, pluck="name", limit_page_length=0
	)
	totals = {}
	for name in orders:
		order = frappe.get_doc("Sales Order", name)
		order.check_permission("read")
		for row in order.items:
			key = (row.item_code, row.stock_uom)
			item = totals.setdefault(
				key, {"item_code": row.item_code, "item_name": row.item_name, "uom": row.stock_uom, "qty": 0}
			)
			item["qty"] += flt(row.stock_qty)
	return sorted(totals.values(), key=lambda row: row["qty"], reverse=True)[:20]


def login_home(response, request=None):
	"""Use the salesperson landing page even when an older default workspace is set."""
	if frappe.local.response.get("message") != "Logged In" or not response.is_json:
		return
	if enabled():
		payload = response.get_json()
		payload["home_page"] = "/app/home"
		response.set_data(frappe.as_json(payload))


@frappe.whitelist()
def notifications(start=0):
	"""Account-scoped tracking notifications, including previous DSRs."""
	from frappe.utils import cint

	from .security import account_for

	if not enabled():
		frappe.throw("Sales Role Profile required.", frappe.PermissionError)
	account = account_for()
	return frappe.get_all(
		"DSR Tracking Event",
		filters={"account": account},
		fields=["name", "event_type", "recorded_at", "details", "duty"],
		order_by="recorded_at desc, name desc",
		limit_start=max(0, cint(start)),
		limit_page_length=100,
	)
