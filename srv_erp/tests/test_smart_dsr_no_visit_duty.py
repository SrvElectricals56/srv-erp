"""Zero-visit closure requires a reason and reverses benefits without deleting evidence."""

import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api, meal_expenses
from srv_erp.smart_dsr import no_visit_duty as rule


class TestNoVisitDuty(unittest.TestCase):
	def setUp(self):
		def throw(message, *args, **kwargs):
			raise frappe.ValidationError(message)

		for stub in (
			patch("srv_erp.smart_dsr.night_stay.duty_off_wait", return_value={"remaining_seconds": 0}),
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(frappe, "throw", side_effect=throw),
		):
			stub.start()
			self.addCleanup(stub.stop)

	def test_reason_required_and_bounded(self):
		for value in (None, "", "  ", {}, "a" * 2001):
			with self.subTest(value=type(value)), self.assertRaises(frappe.ValidationError):
				rule.validate_reason(value)
		self.assertEqual(rule.validate_reason("  Vehicle breakdown  "), "Vehicle breakdown")

	def test_no_visit_reason_is_enforced_before_gps_or_expenses(self):
		doc = frappe._dict(name="duty", status="Active")
		with (
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(api, "locked_exists", return_value=False),
			patch.object(api, "gps_batch") as gps,
			patch.object(rule, "reverse_benefits") as reverse,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "reason is required"):
				api.duty_off("duty", {"latitude": 28, "longitude": 77, "accuracy": 5})
			gps.assert_not_called()
			reverse.assert_not_called()

	def test_close_zero_visit_or_normal_duty(self):
		for completed in (False, True):
			doc = frappe._dict(name="duty", account="user", status="Active", gps_exception="Authorized")
			with (
				self.subTest(completed=completed),
				patch.object(api, "duty_doc", return_value=doc),
				patch.object(
					api,
					"locked_exists",
					side_effect=lambda dt, filters: dt == "DSR Dealer Activity"
					and filters.get("status") == "Completed"
					and completed,
				),
				patch.object(api, "now_datetime", return_value=datetime(2026, 11, 17, 18)),
				patch.object(rule, "reverse_benefits") as reverse,
				patch.object(meal_expenses, "post_due_meals") as meals,
				patch.object(api, "recalculate"),
				patch.object(api, "save"),
				patch.object(api, "event"),
				patch.object(api, "summary", return_value={}),
			):
				api.duty_off("duty", duty_off_reason=None if completed else "Vehicle breakdown")
				self.assertEqual(doc.status, "Closed")
				if completed:
					meals.assert_called_once_with(doc)
					reverse.assert_not_called()
				else:
					reverse.assert_called_once_with(doc)
					meals.assert_not_called()
					self.assertEqual(doc.no_visit_duty, 1)
					self.assertEqual(doc.duty_off_reason, "Vehicle breakdown")

	def test_excluded_duty_has_no_time_or_fuel_entitlement(self):
		doc = frappe._dict(no_visit_duty=1, verified_km=50, fuel_rate=8)
		self.assertEqual(api.fuel_entitlement(doc), 0)
		self.assertEqual(api.duty_seconds(doc), 0)
		self.assertEqual(meal_expenses.legacy_allowance(doc), 0)
		doc.no_visit_duty = 0
		self.assertEqual(api.fuel_entitlement(doc), 400)

	def test_cash_and_own_funds_expenses_reverse_once_and_keep_original_amounts(self):
		doc = frappe._dict(
			name="duty",
			account="user",
			duty_off_reason="Breakdown",
			fuel_reimbursement=40,
			meal_allowance=100,
		)
		expenses = {
			name: frappe._dict(name=name, posting_status="Recorded", amount=amount)
			for name, amount in [("meal", 150), ("toll", 200), ("own", 100)]
		}
		allowance = frappe._dict(allowance=100)
		credits = []

		def rows(dt, **kwargs):
			if dt == "DSR Expense Record":
				return [name for name, row in expenses.items() if row.posting_status != "Reversed"]
			if dt == "DSR Break":
				return ["break"] if allowance.allowance else []
			name = kwargs["filters"]["source_name"]
			return [] if name == "own" else [frappe._dict(name="cash-" + name, amount=-expenses[name].amount)]

		def ledger(*args):
			credits.append(args)

		with (
			patch.object(frappe, "get_all", side_effect=rows),
			patch.object(
				frappe,
				"get_doc",
				side_effect=lambda dt, name, **kwargs: allowance if dt == "DSR Break" else expenses[name],
			),
			patch.object(frappe, "db", Mock()) as db,
			patch.object(api, "ledger", side_effect=ledger),
			patch.object(api, "save"),
			patch.object(api, "event"),
		):
			db.exists.return_value = False
			rule.reverse_benefits(doc)
			rule.reverse_benefits(doc)
		self.assertEqual(sum(row[2] for row in credits), 350)
		self.assertEqual(len(credits), 2)
		self.assertTrue(all(row.posting_status == "Reversed" for row in expenses.values()))
		self.assertEqual(expenses["own"].amount, 100)
		self.assertEqual(allowance.allowance, 0)
		self.assertEqual(doc.fuel_reimbursement, 0)
		self.assertEqual(doc.meal_allowance, 0)

	def test_readiness_reports_zero_visit_reason_requirement(self):
		with (
			patch.object(
				api, "duty_doc", return_value=frappe._dict(name="duty", account="user", status="Active")
			),
			patch.object(frappe, "db", Mock()) as db,
			patch.object(frappe, "get_all", return_value=[]),
		):
			db.exists.return_value = False
			result = api.duty_off_readiness("duty")
			self.assertTrue(result["ready"])
			self.assertTrue(result["requires_no_visit_reason"])
