"""Dealer picker includes every assigned, readable Customer."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api


class TestDealerSearch(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)

	def test_all_assigned_customers_are_requested_without_thirty_row_cap(self):
		customers = [frappe._dict(name=f"Dealer-{i}", customer_name=f"Dealer {i}") for i in range(75)]
		with (
			patch.object(api, "identity", return_value="user"),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value="Salesperson"))),
			patch.object(frappe, "get_list", return_value=customers) as query,
		):
			self.assertEqual(len(api.search_dealers()), 75)
			self.assertEqual(query.call_args.args, ("Customer",))
			self.assertEqual(
				query.call_args.kwargs["filters"], {"disabled": 0, "sales_person": "Salesperson"}
			)
			self.assertEqual(query.call_args.kwargs["limit_page_length"], 0)
			self.assertEqual(query.call_args.kwargs["order_by"], "customer_name asc, name asc")
			self.assertNotIn("ignore_permissions", query.call_args.kwargs)

	def test_search_and_legacy_territory_filter_preserve_assignment(self):
		with (
			patch.object(api, "identity", return_value="user"),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value="Salesperson"))),
			patch.object(frappe, "get_list", return_value=[]) as query,
		):
			api.search_dealers("Firm", territory="Punjab")
			self.assertEqual(
				query.call_args.kwargs["filters"],
				{"disabled": 0, "sales_person": "Salesperson", "territory": "Punjab"},
			)
			self.assertEqual(query.call_args.kwargs["or_filters"]["customer_name"], ["like", "%Firm%"])
