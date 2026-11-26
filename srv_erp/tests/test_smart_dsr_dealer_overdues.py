"""The dues endpoint must stay within the current salesperson's readable dealers."""

import unittest
from datetime import date
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api


class TestDealerOverdues(unittest.TestCase):
	def setUp(self):
		for stub in (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(api, "identity", return_value="sales@example.com"),
			patch("srv_erp.overdues.company_name", return_value="Company"),
			patch.object(api, "settings", return_value=frappe._dict(company="Company")),
			patch.object(
				api,
				"getdate",
				side_effect=lambda value=None: date.fromisoformat(str(value))
				if value
				else date(2026, 11, 17),
			),
		):
			stub.start()
			self.addCleanup(stub.stop)

	def test_only_allocated_readable_dealers_and_manual_overdues_are_queried(self):
		customers = [frappe._dict(name="Dealer-A", customer_name="Dealer A", territory="Delhi")]
		invoices = [
			frappe._dict(
				customer="Dealer-A",
				currency=currency,
				overdue_amount=amount,
				entry_count=2,
				oldest_due_date="2026-11-10",
			)
			for currency, amount in [("INR", 30000), ("USD", 100)]
		]
		with (
			patch.object(frappe, "db", Mock()) as db,
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(frappe, "get_list", return_value=customers) as dealers,
			patch.object(frappe, "get_all", return_value=invoices) as query,
		):
			db.get_value.return_value = "Salesperson"
			result = api.allocated_dealer_overdues()
			self.assertEqual(
				dealers.call_args.kwargs["filters"], {"sales_person": "Salesperson", "disabled": 0}
			)
			self.assertEqual(query.call_args.args, ("Dealer Overdue",))
			self.assertEqual(
				query.call_args.kwargs["filters"],
				{
					"customer": ["in", ["Dealer-A"]],
					"company": "Company",
					"state": "Active",
					"entry_date": ["<=", date(2026, 11, 17)],
					"outstanding_amount": [">", 0],
					"due_date": ["<", date(2026, 11, 17)],
				},
			)
			self.assertEqual(result["totals"], {"INR": 30000, "USD": 100})
			self.assertEqual(result["rows"][0]["days_overdue"], 7)

	def test_missing_assignment_permission_or_dealers_never_queries_invoices(self):
		for sales, permission, customers in (
			(None, True, []),
			("Salesperson", False, []),
			("Salesperson", True, []),
		):
			with (
				self.subTest(sales=sales, permission=permission),
				patch.object(frappe, "db", Mock()) as db,
				patch.object(frappe, "has_permission", return_value=permission),
				patch.object(frappe, "get_list", return_value=customers),
				patch.object(frappe, "get_all") as invoices,
			):
				db.get_value.return_value = sales
				self.assertEqual(api.allocated_dealer_overdues()["rows"], [])
				invoices.assert_not_called()

	def test_visit_dues_use_remaining_manual_balances_for_the_authorized_dealer(self):
		dealer = frappe._dict(name="Dealer-A", customer_name="Dealer A", customer_primary_address=None)
		entries = [
			frappe._dict(name="DUE-1", due_date="2026-11-10", outstanding_amount=700, currency="INR"),
			frappe._dict(name="DUE-2", due_date="2026-11-17", outstanding_amount=300, currency="INR"),
		]
		with (
			patch.object(api, "dealer", return_value=dealer) as authorize,
			patch.object(frappe, "get_all", return_value=entries) as query,
			patch.object(frappe, "get_cached_value", return_value="INR"),
		):
			result = api.outstanding("Dealer-A")
			authorize.assert_called_once_with("Dealer-A")
			self.assertEqual(query.call_args.args, ("Dealer Overdue",))
			self.assertEqual(query.call_args.kwargs["filters"]["customer"], "Dealer-A")
			self.assertEqual(query.call_args.kwargs["filters"]["state"], "Active")
			self.assertEqual(result["overdue"], 700)
			self.assertEqual(result["pending"], 1000)
			self.assertEqual(result["entries"][0]["name"], "DUE-1")
			self.assertEqual(result["source"], "manual")
