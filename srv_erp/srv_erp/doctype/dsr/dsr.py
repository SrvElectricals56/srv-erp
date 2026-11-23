from __future__ import annotations

import re
from typing import TYPE_CHECKING

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt, getdate

from srv_erp.selling.dsr import validate_dsr_submission_deadline

if TYPE_CHECKING:
	from frappe.types import DF

	from srv_erp.srv_erp.doctype.dsr_approved_expense.dsr_approved_expense import DSRApprovedExpense
	from srv_erp.srv_erp.doctype.dsr_customer.dsr_customer import DSRCustomer
	from srv_erp.srv_erp.doctype.dsr_expense.dsr_expense import DSRExpense
	from srv_erp.srv_erp.doctype.dsr_lead.dsr_lead import DSRLead
	from srv_erp.srv_erp.doctype.dsr_receipt.dsr_receipt import DSRReceipt
	from srv_erp.srv_erp.doctype.dsr_sales_person_accompanied.dsr_sales_person_accompanied import (
		DSRSalesPersonAccompanied,
	)
	from srv_erp.srv_erp.doctype.dsr_town_visit.dsr_town_visit import DSRTownVisit


AUDIT_ROLES = {
	"Administrator",
	"System Manager",
	"Accounts Manager",
	"Auditor",
	"Payment Auditor",
}
AUDIT_FIELDS = (
	"payment_audited",
	"payment_rejected",
	"partially_paid",
	"reason_for_rejection",
)


class DSR(Document):
	if TYPE_CHECKING:
		dsr_sales_person_accompanied: DF.Table[DSRSalesPersonAccompanied]
		amount_for_travel: DF.Currency
		amount_paid: DF.Currency
		daily_sales_expense_by_admin_approved_amount: DF.Table[DSRApprovedExpense]
		daily_sales_customer: DF.Table[DSRCustomer]
		date: DF.Date
		custom_day: DF.Data
		end_reading: DF.Int
		end_reading_pic: DF.AttachImage | None
		daily_sales_expenses_by_admin: DF.Table[DSRExpense]
		fuel_added: DF.Check
		fuel_quantity: DF.Float
		lead: DF.Table[DSRLead]
		km_travelled: DF.Int
		miscellaneous_informations: DF.Text | None
		partially_paid: DF.Check
		payment_audited: DF.Check
		payment_rejected: DF.Check
		rate_per_liter: DF.Currency
		reason_for_rejection: DF.Data | None
		receipts: DF.Table[DSRReceipt]
		sales_person: DF.Link
		start_reading: DF.Int
		start_reading_pic: DF.AttachImage | None
		total_amount: DF.Currency
		visits: DF.Table[DSRTownVisit]

	def before_insert(self):
		if not self.get("smart_dsr") and frappe.session.user != "Administrator":
			frappe.throw("Use Smart DSR Duty ON to create a daily report.", frappe.PermissionError)

	def validate(self) -> None:
		if self.get("smart_dsr") or (
			self.get_doc_before_save() and self.get_doc_before_save().get("smart_dsr")
		):
			self.validate_smart_dsr()
			return
		self.validate_opening_balance_permissions()
		self.custom_day = getdate(self.date).strftime("%A") if self.date else ""
		self.set_reading_values()
		self.set_fuel_quantity()
		self.set_total_amount()
		self.set_daily_balance()
		self.validate_lead_contacts()
		self.validate_participants()
		self.validate_audit_state()
		self.validate_audit_permissions()

	def before_submit(self) -> None:
		if self.get("smart_dsr"):
			self.validate_smart_dsr()
			return
		validate_dsr_submission_deadline(self)

	def before_update_after_submit(self) -> None:
		if self.get("smart_dsr"):
			self.validate_smart_dsr()
			return
		self.validate_opening_balance_permissions()
		self.validate_audit_state()
		self.validate_audit_permissions()

	def on_update(self) -> None:
		self.relink_private_receipts()

	def on_update_after_submit(self) -> None:
		self.relink_private_receipts()

	def set_reading_values(self) -> None:
		for fieldname in ("start_reading", "end_reading"):
			value = self.get(fieldname)
			if not re.fullmatch(r"[0-9]+", str(value if value is not None else "")):
				frappe.throw(_("{0} must contain whole numbers only.").format(self.meta.get_label(fieldname)))
		start_reading = flt(self.start_reading)
		end_reading = flt(self.end_reading)
		if end_reading < start_reading:
			frappe.throw(_("End Reading cannot be lower than Start Reading."))

		self.km_travelled = end_reading - start_reading
		self.amount_for_travel = flt(self.km_travelled) * self.get_travel_rate()

	def get_travel_rate(self) -> float:
		if not self.sales_person:
			return 0
		return flt(frappe.get_cached_value("Sales Person", self.sales_person, "travel_rate"))

	def set_fuel_quantity(self) -> None:
		if not self.fuel_added:
			self.fuel_quantity = 0
			return

		rate = flt(self.rate_per_liter)
		self.fuel_quantity = flt(self.amount_paid) / rate if rate else 0

	def set_total_amount(self) -> None:
		expense_amount = sum(flt(row.amount) for row in (self.get("daily_sales_expenses_by_admin") or []))
		fuel_amount = flt(self.amount_paid) if self.fuel_added else 0
		self.total_amount = flt(self.amount_for_travel) + expense_amount + fuel_amount

	def set_daily_balance(self) -> None:
		precision = self.precision("closing_balance")
		collected = 0
		for row in self.get("lead") or []:
			if flt(row.get("money_collected")) < 0:
				frappe.throw(_("Leads Visited row {0}: Money Collected cannot be negative.").format(row.idx))
			collected += flt(row.get("money_collected"))
		collected = flt(collected, precision)
		self.money_collected_total = collected
		self.daily_expenses_total = flt(
			sum(flt(row.amount) for row in (self.get("daily_sales_expenses_by_admin") or [])),
			precision,
		)
		self.fuel_expenses_total = flt(self.amount_paid, precision) if self.fuel_added else 0
		self.closing_balance = flt(
			flt(self.opening_balance) + collected - self.daily_expenses_total - self.fuel_expenses_total,
			precision,
		)

	def validate_smart_dsr(self):
		if not self.flags.smart_dsr_write:
			frappe.throw("Use the Smart DSR service to change this report.", frappe.PermissionError)
		from srv_erp.smart_dsr.api import cash_balance

		duty = frappe.get_doc("DSR Duty Session", self.smart_duty)
		self.opening_balance = duty.opening_balance
		self.closing_balance = cash_balance(duty)
		self.km_travelled = duty.verified_km
		self.amount_for_travel = duty.fuel_reimbursement
		self.total_amount = (
			duty.fuel_reimbursement
			+ duty.meal_allowance
			+ sum(
				frappe.get_all(
					"DSR Expense Record",
					filters={
						"duty": duty.name,
						"category": ["!=", "Fuel Reimbursement"],
						"posting_status": ["!=", "Reversed"],
					},
					pluck="amount",
				)
			)
		)
		self.custom_day = getdate(self.date).strftime("%A")

	def validate_opening_balance_permissions(self) -> None:
		previous = self.get_doc_before_save()
		opening_balance = flt(previous.opening_balance) if previous else 0
		if (
			frappe.session.user != "Administrator"
			and "Sales Manager" not in frappe.get_roles()
			and flt(self.get("opening_balance")) != opening_balance
		):
			frappe.throw("Only Administrator can set or change Opening Balance.", frappe.PermissionError)
		# Earlier code embedded collections in opening cash. Normalize only on the
		# next ordinary save, preserving all untouched historical records and audit history.
		if (
			previous
			and not previous.get("balance_rules_version")
			and flt(self.opening_balance) == opening_balance
		):
			self.opening_balance = opening_balance - flt(previous.get("money_collected_total"))
		self.balance_rules_version = 1

	def before_cancel(self):
		if self.get("smart_dsr"):
			frappe.throw(
				"Finalized Smart DSR reports cannot be cancelled. Record an authorized correction in the next DSR.",
				frappe.PermissionError,
			)

	def on_trash(self):
		if self.get("smart_dsr"):
			frappe.throw("Smart DSR financial audit records cannot be deleted.", frappe.PermissionError)

	@frappe.whitelist()
	def set_last_end_reading(self) -> float:
		if not self.sales_person or not self.date:
			return 0

		readings = frappe.get_all(
			"DSR",
			filters={
				"sales_person": self.sales_person,
				"date": ("<", self.date),
				"docstatus": ("<", 2),
				"name": ("!=", self.name or ""),
			},
			pluck="end_reading",
			order_by="date desc, creation desc",
			limit=1,
		)
		self.start_reading = flt(readings[0]) if readings else 0
		return self.start_reading

	def validate_lead_contacts(self) -> None:
		for row in self.get("lead") or []:
			if row.contact_number and not re.fullmatch(r"\+[1-9][0-9]{0,2}-[0-9]{10}", row.contact_number):
				frappe.throw(
					_(
						"Leads Visited row {0}: select a country code and enter exactly 10 digits for Contact Number (for example, +91-9876543210)."
					).format(row.idx)
				)

	def validate_participants(self) -> None:
		if not self.date or not self.sales_person:
			return

		participants = [
			self.sales_person,
			*(row.sales_person for row in (self.get("dsr_sales_person_accompanied") or [])),
		]
		participants = [participant for participant in participants if participant]
		if len(participants) != len(set(participants)):
			frappe.throw(_("A Sales Person can only appear once in a DSR."))

	def validate_audit_state(self) -> None:
		selected_states = sum(
			bool(value) for value in (self.payment_audited, self.payment_rejected, self.partially_paid)
		)
		if selected_states > 1:
			frappe.throw(
				_("Payment Audited, Payment Rejected, and Partially Paid cannot be selected together.")
			)

		if self.payment_rejected and not self.reason_for_rejection:
			frappe.throw(_("Reason for Rejection is required when a DSR is rejected."))
		if not self.payment_rejected:
			self.reason_for_rejection = None

		if self.partially_paid:
			if not self.get("daily_sales_expense_by_admin_approved_amount"):
				frappe.throw(_("Approved Expenses are required for a partially paid DSR."))

			claimed = sum(flt(row.amount) for row in (self.get("daily_sales_expenses_by_admin") or []))
			approved = sum(
				flt(row.amount) for row in (self.get("daily_sales_expense_by_admin_approved_amount") or [])
			)
			if approved > claimed:
				frappe.throw(_("Approved expense amount cannot exceed the claimed expense amount."))
		elif self.get("daily_sales_expense_by_admin_approved_amount"):
			self.set("daily_sales_expense_by_admin_approved_amount", [])

	def validate_audit_permissions(self) -> None:
		if not self.audit_fields_changed():
			return
		if not AUDIT_ROLES.intersection(frappe.get_roles()):
			frappe.throw(
				_("Only a payment auditor or manager can update DSR payment audit fields."),
				frappe.PermissionError,
			)

	def audit_fields_changed(self) -> bool:
		previous = self.get_doc_before_save()
		if not previous:
			return any(self.get(field) for field in AUDIT_FIELDS) or bool(
				self.get("daily_sales_expense_by_admin_approved_amount")
			)

		if any(self.get(field) != previous.get(field) for field in AUDIT_FIELDS):
			return True

		current_rows = [
			(row.type, flt(row.amount), row.description or "")
			for row in (self.get("daily_sales_expense_by_admin_approved_amount") or [])
		]
		previous_rows = [
			(row.type, flt(row.amount), row.description or "")
			for row in (previous.get("daily_sales_expense_by_admin_approved_amount") or [])
		]
		return current_rows != previous_rows

	def relink_private_receipts(self) -> None:
		for row in self.get("receipts") or []:
			if not row.receipt_image or not row.receipt_image.startswith("/private/files/"):
				continue

			file_name = frappe.db.exists("File", {"file_url": row.receipt_image})
			if not file_name:
				continue

			if frappe.db.get_value("File", file_name, "attached_to_name") == self.name:
				continue

			frappe.db.set_value(
				"File",
				file_name,
				{
					"attached_to_doctype": self.doctype,
					"attached_to_name": self.name,
					"attached_to_field": "receipts",
					"is_private": 1,
				},
				update_modified=False,
			)
