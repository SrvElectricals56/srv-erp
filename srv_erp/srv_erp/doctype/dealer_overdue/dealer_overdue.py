"""Manual dealer dues; saving these records never posts accounting transactions."""

from math import isfinite

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate, nowdate

from srv_erp.overdues import company_name


class DealerOverdue(Document):
	def validate(self):
		self.company = company_name()
		self.currency = frappe.get_cached_value("Company", self.company, "default_currency")
		if not (
			frappe.has_permission("Customer", "read", doc=self.customer)
			or frappe.has_permission("Customer", "select", doc=self.customer)
		):
			frappe.throw(_("You do not have permission to access this dealer."), frappe.PermissionError)
		self.customer_name, self.territory, self.sales_person = frappe.db.get_value(
			"Customer", self.customer, ["customer_name", "territory", "sales_person"]
		) or (self.customer, None, None)
		for field in ("amount", "amount_received"):
			try:
				value = float(self.get(field) or 0)
			except (TypeError, ValueError, OverflowError):
				frappe.throw(_("Enter valid amounts."))
			if not isfinite(value):
				frappe.throw(_("Enter finite amounts."))
			self.set(field, flt(value, self.precision(field)))
		if self.amount <= 0:
			frappe.throw(_("Total Amount must be greater than zero."))
		if self.amount_received < 0 or self.amount_received > self.amount:
			frappe.throw(_("Amount Received must be between zero and Total Amount."))
		self.entry_date = getdate(self.entry_date or nowdate())
		if self.entry_date is None:
			frappe.throw(_("Enter a valid Record Date."))
		if self.entry_date > getdate(nowdate()):
			frappe.throw(_("Record Date cannot be in the future."))
		if not self.due_date:
			frappe.throw(_("Due Date is required."))
		self.due_date = getdate(self.due_date)
		if self.due_date is None:
			frappe.throw(_("Enter a valid Due Date."))
		if self.state not in ("Active", "Cancelled"):
			frappe.throw(_("Select a valid Record State."))
		self.outstanding_amount = flt(
			self.amount - self.amount_received, self.precision("outstanding_amount")
		)
