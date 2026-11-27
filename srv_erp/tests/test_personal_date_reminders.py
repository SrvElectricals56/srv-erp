from datetime import date
from unittest import TestCase
from unittest.mock import MagicMock, patch

import frappe

from srv_erp.customer import personal_date_reminders as reminders


class TestPersonalDateReminders(TestCase):
	def test_annual_dates_and_leap_years(self):
		for value, target in (
			("1980-01-01", date(2027, 1, 1)),
			("2000-02-29", date(2027, 2, 28)),
			("2000-02-29", date(2028, 2, 29)),
		):
			self.assertTrue(reminders.occurs_on(value, target))
		self.assertFalse(reminders.occurs_on(None, date(2026, 11, 27)))
		self.assertFalse(reminders.occurs_on("2000-02-29", date(2028, 2, 28)))

	def test_all_customers_milestones_recipients_and_duplicates(self):
		customers = [frappe._dict(name=str(i), customer_name=str(i), sales_person="Sales",
			custom_date_of_birth=value, custom_marriage_anniversary=value)
			for i, value in enumerate(("1980-11-27", "1990-11-30", "2000-12-07"))]
		seen = set()
		logs = []

		def get_all(doctype, **kwargs):
			if doctype == "Customer":
				self.assertEqual(kwargs["filters"], {"disabled": 0})
				return customers
			if doctype == "Sales Person":
				return [("Sales", "sales@example.com")]
			return ["staff@example.com"] if "user_type" in kwargs["filters"] else ["staff@example.com", "sales@example.com"]

		def get_doc(values):
			def insert(**kwargs):
				seen.add(kwargs["set_name"])
				logs.append(values)
			return MagicMock(insert=insert)

		with patch.object(reminders, "nowdate", return_value="2026-11-27"), patch.object(
			frappe, "get_all", side_effect=get_all
		), patch.object(frappe, "get_doc", side_effect=get_doc), patch.object(
			frappe, "db", MagicMock(exists=lambda doctype, key: key in seen)
		), patch.object(reminders, "_", side_effect=lambda value: value):
			self.assertEqual(reminders.send_personal_date_reminders(), 12)
			self.assertEqual(reminders.send_personal_date_reminders(), 0)
		self.assertEqual({log["document_name"] for log in logs}, {"0", "1", "2"})
		self.assertEqual({log["for_user"] for log in logs}, {"staff@example.com", "sales@example.com"})
