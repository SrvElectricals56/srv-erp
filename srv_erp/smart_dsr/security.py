"""All operational writes go through the authenticated, serialized service layer."""

import frappe
from frappe.model.document import Document

from .admin_permissions import is_admin


class SmartDocument(Document):
	def validate(self):
		if self.doctype == "DSR Settings":
			if frappe.session.user != "Administrator":
				frappe.throw("Only Administrator can change DSR Settings.", frappe.PermissionError)
			for field in (
				"cng_rate",
				"diesel_rate",
				"petrol_rate",
				"breakfast_amount",
				"lunch_amount",
				"dinner_amount",
			):
				if float(self.get(field) or 0) < 0:
					frappe.throw("Rates and allowances cannot be negative.")
			for field in (
				"max_accuracy_m",
				"max_speed_kmh",
				"max_gap_seconds",
				"interruption_minutes",
				"retention_days",
			):
				if float(self.get(field) or 0) <= 0:
					frappe.throw("Tracking thresholds and retention must be positive.")
			return
		if self.is_new() and self.meta.has_field("account") and not self.get("account"):
			frappe.throw("A User account is required for new Smart DSR records.")
		if not self.flags.smart_dsr_write:
			frappe.throw("Use Smart DSR operations to preserve the audit trail.", frappe.PermissionError)

	def on_trash(self):
		frappe.throw("Smart DSR audit records cannot be deleted. Use a reversal.", frappe.PermissionError)


def account_for(user=None, lock=False):
	"""Smart DSR identity is an enabled User with an explicitly assigned DSR role."""
	user = user or frappe.session.user
	if user == "Guest":
		frappe.throw("Please sign in with your User email and password.", frappe.AuthenticationError)
	if not frappe.db.get_value("User", user, "enabled"):
		frappe.throw("This User account is disabled or no longer exists.", frappe.PermissionError)
	if frappe.db.has_column("User", "smart_dsr_disabled") and frappe.db.get_value(
		"User", user, "smart_dsr_disabled"
	):
		frappe.throw(
			"Smart DSR access is deactivated for this User. Contact Administrator.", frappe.PermissionError
		)
	if not is_admin(user) and not {"Sales Person", "Sales Manager"}.intersection(frappe.get_roles(user)):
		frappe.throw("Smart DSR requires the Sales Person or Sales Manager role.", frappe.PermissionError)
	if lock:
		frappe.db.sql("select name from `tabUser` where name=%s for update", user)
	return user


def query(user=None):
	user = user or frappe.session.user
	if is_admin(user):
		return ""
	return "account = {0}".format(frappe.db.escape(account_for(user)))


def permission(doc, user=None, permission_type=None, **kwargs):
	user = user or frappe.session.user
	if permission_type not in (None, "read", "select", "report", "print"):
		return False
	if is_admin(user):
		return True
	return doc.get("account") == account_for(user)


def legacy_query(user=None):
	user = user or frappe.session.user
	if user == "Administrator" or {
		"System Manager",
		"Accounts Manager",
		"Sales Manager",
		"Auditor",
		"Payment Auditor",
	}.intersection(frappe.get_roles(user)):
		return ""
	return "owner = {0}".format(frappe.db.escape(user))


def legacy_permission(doc, user=None, **kwargs):
	user = user or frappe.session.user
	if user == "Administrator" or {
		"System Manager",
		"Accounts Manager",
		"Sales Manager",
		"Auditor",
		"Payment Auditor",
	}.intersection(frappe.get_roles(user)):
		return None
	return doc.owner == user


def protect_evidence_file(doc, method=None):
	previous = doc.get_doc_before_save()

	def protected_attachment(row):
		return row and (
			row.attached_to_doctype == "DSR Dealer Photo Evidence"
			or (
				row.attached_to_doctype == "DSR Duty Session"
				and row.attached_to_field in ("odometer_start_photo", "odometer_end_photo")
			)
		)

	protected = protected_attachment(doc) or protected_attachment(previous)
	if protected and not frappe.flags.smart_dsr_evidence_write:
		frappe.throw(
			"Camera evidence files are immutable. Administrator retention review is required.",
			frappe.PermissionError,
		)
