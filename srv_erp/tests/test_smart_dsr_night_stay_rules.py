"""Night stay timing, location and once-only expense rules."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api
from srv_erp.smart_dsr import night_stay as night
from srv_erp.smart_dsr.meal_expenses import INDIA


class TestNightStayRules(unittest.TestCase):
	def setUp(self):
		for mock in (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(frappe, "throw", side_effect=self.throw),
		):
			mock.start()
			self.addCleanup(mock.stop)

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_on_requires_2130_and_twelve_hours(self):
		for now, hours, started, expected in (
			(
				datetime(2026, 11, 16, 21, 29, tzinfo=INDIA),
				13,
				datetime(2026, 11, 16, 8, tzinfo=INDIA),
				False,
			),
			(
				datetime(2026, 11, 16, 21, 30, tzinfo=INDIA),
				11.99,
				datetime(2026, 11, 16, 9, 31, tzinfo=INDIA),
				False,
			),
			(
				datetime(2026, 11, 16, 21, 30, tzinfo=INDIA),
				12,
				datetime(2026, 11, 16, 9, 30, tzinfo=INDIA),
				True,
			),
			(
				datetime(2026, 11, 17, 1, 30, tzinfo=INDIA),
				16,
				datetime(2026, 11, 16, 9, 30, tzinfo=INDIA),
				True,
			),
		):
			with (
				self.subTest(now=now, hours=hours),
				patch.object(api, "now_datetime", return_value=now),
				patch.object(api, "duty_seconds", return_value=hours * 3600),
				patch.object(night, "continuous_start", return_value=started),
			):
				self.assertEqual(night.eligibility(frappe._dict(status="Active"))["eligible"], expected)

	def test_off_waits_four_hours_and_checks_500m(self):
		started = datetime(2026, 11, 16, 21, 30)
		row = frappe._dict(
			name="stay",
			account="user",
			duty="duty",
			checked_in_at=started,
			checked_out_at=None,
			latitude=28,
			longitude=77,
			accuracy=5,
		)
		row.as_dict = lambda: dict(row)
		with (
			patch.object(api, "identity", return_value="user"),
			patch.object(frappe, "get_doc", return_value=row),
			patch.object(api, "active", return_value=frappe._dict(name="duty")),
			patch.object(api, "location", return_value=dict(latitude=28, longitude=77, accuracy=5)),
			patch.object(api, "settings", return_value=frappe._dict(max_accuracy_m=50)),
			patch.object(api, "record_expense_document", return_value={"name": "expense"}) as expense,
			patch.object(api, "recalculate"),
			patch.object(api, "save"),
		):
			with (
				patch.object(
					api, "now_datetime", return_value=started + timedelta(hours=4) - timedelta(seconds=1)
				),
				self.assertRaises(frappe.ValidationError),
			):
				night.turn_off("stay", {})
			expense.assert_not_called()
			with (
				patch.object(api, "now_datetime", return_value=started + timedelta(hours=4)),
				patch.object(night, "geofence", return_value="Outside"),
				self.assertRaises(frappe.ValidationError),
			):
				night.turn_off("stay", {})
			expense.assert_not_called()
			with patch.object(api, "now_datetime", return_value=started + timedelta(hours=4)):
				self.assertEqual(night.turn_off("stay", {}), "stay")
			self.assertEqual(row.expense_amount, 1200)
			self.assertEqual(row.duration_minutes, 240)
			self.assertEqual(row.checkout_latitude, 28)
			self.assertEqual(expense.call_args.args[1:4], ("Night Stay", 1200, 1))
			self.assertEqual(night.turn_off("stay", {}), "stay")
			expense.assert_called_once()

	def test_other_user_cannot_checkout(self):
		with (
			patch.object(api, "identity", return_value="other"),
			patch.object(frappe, "get_doc", return_value=frappe._dict(account="user")),
			self.assertRaises(frappe.PermissionError),
		):
			night.turn_off("stay", {})
