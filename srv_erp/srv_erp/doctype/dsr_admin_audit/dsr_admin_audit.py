import frappe
from frappe.model.document import Document


class DSRAdminAudit(Document):
	def validate(self):
		if not self.is_new() or not self.flags.smart_dsr_admin_audit:
			frappe.throw("Administrative audit history is append-only.", frappe.PermissionError)

	def on_trash(self):
		frappe.throw("Administrative audit history cannot be deleted.", frappe.PermissionError)
