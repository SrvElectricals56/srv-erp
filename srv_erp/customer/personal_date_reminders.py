"""Annual customer birthday and anniversary reminders in the notification bell."""

import calendar
import hashlib
from datetime import timedelta

import frappe
from frappe import _
from frappe.utils import escape_html, getdate, nowdate


def occurs_on(value, target):
	if not value:
		return False
	original = getdate(value)
	# Observe February 29 on February 28 in non-leap years.
	day = min(original.day, calendar.monthrange(target.year, original.month)[1])
	return original.year <= target.year and (original.month, day) == (target.month, target.day)


def send_personal_date_reminders(customer_name=None):
	today = getdate(nowdate())
	users = set(frappe.get_all("User", filters={"enabled": 1, "user_type": "System User"}, pluck="name"))
	sales_users = dict(frappe.get_all("Sales Person", filters={"enabled": 1}, fields=["name", "sales_user"], as_list=True))
	enabled_users = set(frappe.get_all("User", filters={"enabled": 1}, pluck="name"))
	count = 0
	filters = {"disabled": 0}
	if customer_name:
		filters["name"] = customer_name
	for customer in frappe.get_all("Customer", filters=filters, fields=[
		"name", "customer_name", "sales_person", "custom_date_of_birth", "custom_marriage_anniversary"
	]):
		recipients = set(users)
		mapped_user = sales_users.get(customer.sales_person)
		if mapped_user in enabled_users:
			recipients.add(mapped_user)
		for fieldname, label in (("custom_date_of_birth", "Birthday"), ("custom_marriage_anniversary", "Marriage Anniversary")):
			for days in (10, 3, 0):
				event_date = today + timedelta(days=days)
				if not occurs_on(customer.get(fieldname), event_date):
					continue
				for user in sorted(recipients):
					key = hashlib.sha256(f"customer-personal-date:{customer.name}:{fieldname}:{event_date}:{days}:{user}".encode()).hexdigest()
					if frappe.db.exists("Notification Log", key):
						continue
					subject = _("{0}: {1} — {2}").format(
						escape_html(customer.customer_name or customer.name), _(label),
						_("today") if days == 0 else _("in {0} days").format(days),
					)
					frappe.get_doc({
						"doctype": "Notification Log", "type": "Alert",
						"subject": subject, "email_content": subject,
						"for_user": user, "from_user": "Administrator",
						"document_type": "Customer", "document_name": customer.name,
					}).insert(ignore_permissions=True, set_name=key, ignore_if_duplicate=True)
					count += 1
	return count



@frappe.whitelist()
def get_personal_notification_logs(limit=20):
	"""Keep the bell personal even for Administrator, who can audit all logs."""
	from frappe.utils import cint

	logs = frappe.get_all(
		"Notification Log", filters={"for_user": frappe.session.user},
		fields=["*"], limit_page_length=max(1, min(cint(limit), 100)),
		order_by="modified desc",
	)
	user_info = frappe._dict()
	for user in {log.from_user for log in logs if log.from_user}:
		frappe.utils.add_user_info(user, user_info)
	return {"notification_logs": logs, "user_info": user_info}


def send_reminders_on_customer_save(doc, method=None):
	fields = ("custom_date_of_birth", "custom_marriage_anniversary", "sales_person", "disabled")
	if doc.is_new() or any(doc.has_value_changed(field) for field in fields):
		send_personal_date_reminders(customer_name=doc.name)
