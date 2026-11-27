"""Annual birthday and marriage anniversary reminders in the Desk bell."""

import hashlib
from datetime import timedelta

import frappe
from frappe import _
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
from frappe.custom.doctype.property_setter.property_setter import make_property_setter
from frappe.utils import escape_html, getdate, nowdate


def setup_user_occasion_fields():
	create_custom_fields(
		{
			"User": [
				{
					"fieldname": "custom_marriage_anniversary",
					"label": "Marriage Anniversary",
					"fieldtype": "Date",
					"insert_after": "birth_date",
					"no_copy": 1,
				}
			]
		},
		update=True,
	)
	make_property_setter("User", "birth_date", "label", "Date of Birth", "Data")
	# Preserve existing custom fields and move the dates into Basic Details.
	order = [
		field.fieldname
		for field in frappe.get_meta("User").fields
		if field.fieldname not in ("birth_date", "custom_marriage_anniversary")
	]
	position = order.index("last_name") + 1
	order[position:position] = ["birth_date", "custom_marriage_anniversary"]
	make_property_setter("User", None, "field_order", frappe.as_json(order), "Text", for_doctype=True)


def occasion_date(value, target):
	"""Match month/day annually; February 29 is observed February 28 in other years."""
	if not value:
		return False
	original = getdate(value)
	try:
		anniversary = original.replace(year=target.year)
	except ValueError:
		anniversary = original.replace(year=target.year, day=28)
	return anniversary == target and original <= target


def on_session_creation(login_manager):
	"""Create today's missing reminders before the newly logged-in user loads Desk."""
	if login_manager.user and login_manager.user != "Guest":
		return send_user_occasion_reminders(recipient=login_manager.user)
	return 0


def send_user_occasion_reminders(recipient=None):
	"""Notify every enabled user on the occasion and exactly three days before."""
	recipient_filters = {"enabled": 1, "name": ["!=", "Guest"]}
	if recipient:
		if recipient == "Guest":
			return 0
		recipient_filters["name"] = recipient
	recipients = frappe.get_all("User", filters=recipient_filters, pluck="name", order_by="name")
	if not recipients:
		return 0
	today = getdate(nowdate())
	count = 0
	for name in frappe.get_all(
		"User",
		filters={"enabled": 1, "name": ["not in", ["Guest", "Administrator"]]},
		pluck="name",
		order_by="name",
	):
		# A row lock serializes overlapping scheduler/manual runs until transaction commit.
		user = frappe.get_doc("User", name, for_update=True)
		if not user.enabled:
			continue
		for field, label in (
			("birth_date", _("Birthday")),
			("custom_marriage_anniversary", _("Marriage Anniversary")),
		):
			for days in (0, 3):
				target = today + timedelta(days=days)
				if not occasion_date(user.get(field), target):
					continue
				subject = (_("{0}: {1} today") if days == 0 else _("{0}: {1} in 3 days")).format(
					escape_html(user.full_name or user.name), label
				)
				for recipient in recipients:
					key = hashlib.sha256(
						f"srv-occasion:{name}:{field}:{target}:{days}:{recipient}".encode()
					).hexdigest()
					if frappe.db.exists("Notification Log", key):
						continue
					frappe.get_doc(
						{
							"doctype": "Notification Log",
							"type": "Alert",
							"subject": subject,
							"email_content": _("Occasion date: {0}").format(target.isoformat()),
							"for_user": recipient,
							"from_user": "Administrator",
							"document_type": "User",
							"document_name": name,
						}
					).insert(ignore_permissions=True, set_name=key)
					count += 1
	return count
