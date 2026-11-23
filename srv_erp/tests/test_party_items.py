"""Party reports combine current allocations and Frappe document permissions."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import party_items as report


class TestPartyItems(unittest.TestCase):
	def test_party_scope_uses_mapping_and_customer_read_permissions(self):
		with (
			patch.object(report, "account", return_value="sales") as auth,
			patch.object(report, "assigned_salesperson", return_value="Mapped") as mapping,
			patch.object(frappe, "get_list", return_value=[]) as listing,
		):
			report.parties()
			auth.assert_called_once_with()
			mapping.assert_called_once_with("sales")
			self.assertEqual(listing.call_args.args[0], "Customer")
			self.assertEqual(listing.call_args.kwargs["filters"], {"sales_person": "Mapped"})

	def test_parent_query_retains_frappe_permissions_and_does_not_load_document_names(self):
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(
				frappe, "get_list", return_value="select distinct name from permitted_sales"
			) as listing,
		):
			_query, doctype, _child, _date = report.permitted_query(
				"orders", ["Dealer"], "2026-11-01", "2026-11-21", "Company"
			)
			self.assertEqual(doctype, "Sales Order")
			args = listing.call_args.kwargs
			self.assertFalse(args["run"])
			self.assertTrue(args["distinct"])
			self.assertNotIn("ignore_permissions", args)
			self.assertEqual(args["filters"]["docstatus"], 1)
			self.assertEqual(args["filters"]["customer"], ["in", ["Dealer"]])
			self.assertEqual(args["filters"]["company"], "Company")
			self.assertEqual(str(args["filters"]["transaction_date"][1][0]), "2026-11-01")

	def test_other_party_is_rejected_before_querying_sales(self):
		with (
			patch.object(report, "parties", return_value=[frappe._dict(name="Allocated")]),
			patch.object(frappe, "throw", side_effect=frappe.PermissionError),
			patch.object(report, "permitted_query") as query,
		):
			with self.assertRaises(frappe.PermissionError):
				report.report.__wrapped__(customer="Unallocated")
			query.assert_not_called()

	def test_inaccessible_invoice_source_is_denied(self):
		with (
			patch.object(frappe, "has_permission", return_value=False),
			patch.object(frappe, "throw", side_effect=frappe.PermissionError),
			patch.object(frappe, "get_list") as listing,
		):
			with self.assertRaises(frappe.PermissionError):
				report.permitted_query("invoices", ["Dealer"])
			listing.assert_not_called()

	def test_totals_and_rows_use_the_same_permission_subquery_and_bound_search(self):
		db = Mock()
		db.sql.side_effect = [
			[frappe._dict(parties=1, products=1, documents=2)],
			[frappe._dict(uom="Nos", qty=24)],
			[(1,)],
			[],
		]
		with (
			patch.object(report, "parties", return_value=[frappe._dict(name="Dealer")]),
			patch.object(
				report,
				"permitted_query",
				return_value=(
					"select distinct name from allowed_orders",
					"Sales Order",
					"Sales Order Item",
					"transaction_date",
				),
			),
			patch.object(frappe, "db", db),
		):
			result = report.report.__wrapped__(search="' OR 1=1 --", item_code="ITEM", start=50)
			self.assertEqual(result["count"], 1)
		for call in db.sql.call_args_list:
			query, params = call.args
			self.assertIn("select distinct name from allowed_orders", query)
			self.assertIn("line.parentfield='items'", query)
			self.assertNotIn("' OR 1=1 --", query)
			self.assertIn("%' OR 1=1 --%", params)
			self.assertIn("ITEM", params)
		self.assertIn("line.stock_uom", db.sql.call_args_list[2].args[0])
		self.assertEqual(db.sql.call_args_list[-1].args[1][-2:], (50, 50))

	def test_empty_allocation_never_queries_transactions(self):
		with (
			patch.object(report, "parties", return_value=[]),
			patch.object(report, "permitted_query") as query,
		):
			self.assertEqual(report.report.__wrapped__()["count"], 0)
			query.assert_not_called()

	def test_invoice_history_preserves_returns_and_original_uoms(self):
		db = Mock()
		db.sql.side_effect = [[frappe._dict(parties=1, products=1, documents=2)], [], [(2,)], []]
		with (
			patch.object(report, "parties", return_value=[frappe._dict(name="Dealer")]),
			patch.object(
				report,
				"permitted_query",
				return_value=(
					"select name from allowed_invoices",
					"Sales Invoice",
					"Sales Invoice Item",
					"posting_date",
				),
			),
			patch.object(frappe, "db", db),
		):
			report.report.__wrapped__(source="invoices", view="purchases")
		query = db.sql.call_args_list[-1].args[0]
		self.assertIn("sale.is_return", query)
		self.assertIn("line.qty", query)
		self.assertIn("line.stock_qty", query)

	def test_calendar_intervals(self):
		for interval, expected in [
			("monthly", ("2026-11-01", "2026-11-30")),
			("quarterly", ("2026-10-01", "2026-12-31")),
			("half-yearly", ("2026-07-01", "2026-12-31")),
			("yearly", ("2026-01-01", "2026-12-31")),
		]:
			self.assertEqual(report.interval_dates(interval, "2026-11"), expected)
		self.assertEqual(report.interval_dates("monthly", "2024-02"), ("2024-02-01", "2024-02-29"))
