import unittest
from datetime import date
from unittest.mock import Mock, patch

import frappe

from srv_erp import user_occasions as occasions


class TestUserOccasions(unittest.TestCase):
	def test_annual_dates_and_missing_values(self):
		self.assertTrue(occasions.occasion_date("1990-11-27", date(2026, 11, 27)))
		self.assertFalse(occasions.occasion_date(None, date(2026, 11, 27)))
		self.assertFalse(occasions.occasion_date("2027-11-27", date(2026, 11, 27)))
		self.assertFalse(occasions.occasion_date("1990-11-26", date(2026, 11, 27)))

	def test_leap_day_policy(self):
		self.assertTrue(occasions.occasion_date("2000-02-29", date(2027, 2, 28)))
		self.assertTrue(occasions.occasion_date("2000-02-29", date(2028, 2, 29)))
		self.assertFalse(occasions.occasion_date("2000-02-29", date(2028, 2, 28)))

	def test_all_recipients_year_boundary_and_repeat_run(self):
		person = frappe._dict(
			name="person@example.com",
			full_name="Test Person",
			enabled=1,
			birth_date="1990-01-01",
			custom_marriage_anniversary="2010-12-29",
		)
		seen = set()
		created = []

		def get_doc(doctype, name=None, **kwargs):
			if doctype == "User":
				return person

			def insert(**kwargs):
				seen.add(kwargs["set_name"])
				created.append(doctype)

			return Mock(insert=insert)

		with (
			patch.object(occasions, "_", side_effect=lambda text: text),
			patch.object(occasions, "nowdate", return_value="2026-12-29"),
			patch.object(
				frappe,
				"get_all",
				side_effect=lambda *a, **kw: ["person@example.com", "other@example.com"]
				if kw["filters"]["name"][0] == "!="
				else [person.name],
			),
			patch.object(frappe, "get_doc", side_effect=get_doc),
			patch.object(frappe, "db", Mock(exists=lambda dt, key: key in seen)),
		):
			self.assertEqual(occasions.send_user_occasion_reminders(), 4)
			self.assertEqual(occasions.send_user_occasion_reminders(), 0)
		self.assertEqual({row["for_user"] for row in created}, {person.name, "other@example.com"})
		self.assertEqual(sum("in 3 days" in row["subject"] for row in created), 2)

	def test_login_checks_only_logged_in_recipient(self):
		with patch.object(occasions, "send_user_occasion_reminders", return_value=2) as send:
			self.assertEqual(occasions.on_session_creation(frappe._dict(user="raj@gmail.in")), 2)
			send.assert_called_once_with(recipient="raj@gmail.in")

	def test_guest_login_is_ignored(self):
		with patch.object(occasions, "send_user_occasion_reminders") as send:
			self.assertEqual(occasions.on_session_creation(frappe._dict(user="Guest")), 0)
			send.assert_not_called()

	def test_login_recipient_must_be_enabled(self):
		with patch.object(frappe, "get_all", return_value=[]) as query:
			self.assertEqual(occasions.send_user_occasion_reminders(recipient="raj@gmail.in"), 0)
			self.assertEqual(query.call_args.kwargs["filters"], {"enabled": 1, "name": "raj@gmail.in"})
