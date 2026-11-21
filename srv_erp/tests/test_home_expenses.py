"""Expense history cannot expose other users' records or mix reversed totals."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import home_expenses as expenses


class TestHomeExpenses(unittest.TestCase):
	def test_scope_filters_dates_pagination_and_totals(self):
		db = Mock()
		db.sql.side_effect = [[frappe._dict(count=0, amount=0, reversed_amount=0)], []]
		with (
			patch.object(expenses, "account_for", return_value="sales"),
			patch.object(expenses, "settings", return_value=frappe._dict(company="Company")),
			patch.object(frappe, "db", db),
			patch.object(frappe, "get_all", return_value=["Other Expense"]) as categories,
			patch.object(frappe, "get_cached_value", return_value="INR"),
		):
			result = expenses.list_expenses.__wrapped__(
				search="' OR 1=1 --",
				from_date="2026-11-01",
				to_date="2026-11-21",
				category="Other Expense",
				status="Recorded",
				duty="some-duty",
				start=50,
			)
		self.assertEqual(result["currency"], "INR")
		self.assertEqual(categories.call_args.kwargs["filters"], {"account": "sales"})
		for call in db.sql.call_args_list:
			query, params = call.args
			self.assertIn("e.account=%s", query)
			self.assertIn("d.account=e.account", query)
			self.assertEqual(params[0], "sales")
			self.assertIn("2026-11-22 00:00:00", params)
			self.assertIn("some-duty", params)
			self.assertNotIn("' OR 1=1 --", query)
			self.assertIn("%' OR 1=1 --%", params)
		self.assertIn("coalesce(e.posting_status,'Recorded')!='Reversed'", db.sql.call_args_list[0].args[0])
		self.assertEqual(db.sql.call_args_list[1].args[1][-2:], (50, 50))

	def test_invalid_status_and_date_range_do_not_query_records(self):
		for values in ({"status": "invalid"}, {"from_date": "2026-11-22", "to_date": "2026-11-01"}):
			with (
				self.subTest(values=values),
				patch.object(expenses, "account_for", return_value="sales"),
				patch.object(frappe, "throw", side_effect=frappe.ValidationError),
				patch.object(frappe, "db", Mock()) as db,
			):
				with self.assertRaises(frappe.ValidationError):
					expenses.list_expenses.__wrapped__(**values)
				db.sql.assert_not_called()

	def test_disabled_or_unauthorized_account_cannot_query(self):
		with (
			patch.object(expenses, "account_for", side_effect=frappe.PermissionError),
			patch.object(frappe, "db", Mock()) as db,
		):
			with self.assertRaises(frappe.PermissionError):
				expenses.list_expenses.__wrapped__()
			db.sql.assert_not_called()
