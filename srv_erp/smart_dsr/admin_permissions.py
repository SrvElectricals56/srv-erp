"""Explicit, least-privilege access to the DSR control panel."""

import frappe

ADMIN_ROLE = "Sales Manager"
FINANCE_ROLE = "Sales Manager"
ADMIN_ROLE_PROFILES = frozenset({"Sales Manager", "Administrator"})


def is_enabled_user(user):
	"""Use the same User access switches for the panel and salesperson APIs."""
	return (
		user != "Guest"
		and bool(frappe.db.get_value("User", user, "enabled"))
		and not (
			frappe.db.has_column("User", "smart_dsr_disabled")
			and frappe.db.get_value("User", user, "smart_dsr_disabled")
		)
	)


def is_admin(user=None):
	user = user or frappe.session.user
	return is_enabled_user(user) and (
		user == "Administrator"
		or frappe.db.get_value("User", user, "role_profile_name") in ADMIN_ROLE_PROFILES
	)


def require_admin():
	if not is_admin():
		frappe.throw(
			"Smart DSR control panel requires the Sales Manager or Administrator Role Profile.",
			frappe.PermissionError,
		)


def require_finance():
	require_admin()


def require_administrator():
	if frappe.session.user != "Administrator" or not frappe.db.get_value("User", "Administrator", "enabled"):
		frappe.throw("Only Administrator can manage User access and roles.", frappe.PermissionError)


def audit_query(user=None):
	if not is_admin(user):
		return "1=0"
	return ""


def audit_permission(doc=None, user=None, permission_type=None, **kwargs):
	return permission_type in (None, "read", "select", "report", "print") and is_admin(user)


def protect_user_access(doc, method=None):
	old = doc.get_doc_before_save()
	before = old.get("smart_dsr_disabled") if old else 0
	if int(doc.get("smart_dsr_disabled") or 0) != int(before or 0):
		require_administrator()


def add_admin_access_to_boot(bootinfo):
	"""Expose panel access for the Desk command search shortcut."""
	bootinfo.smart_dsr_admin_access = bool(is_admin())
