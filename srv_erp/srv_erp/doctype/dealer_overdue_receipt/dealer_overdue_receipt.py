"""Receipt history for the manual dealer overdue register."""

import frappe
from frappe import _
from frappe.model.document import Document

from srv_erp.overdues import apply_received_amount


class DealerOverdueReceipt(Document):
	def validate(self):
		if not self.is_new():
			frappe.throw(_("Saved receipts cannot be edited."))

	def before_insert(self):
		apply_received_amount(self)
