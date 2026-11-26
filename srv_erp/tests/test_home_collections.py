"""Home must not widen customer access, duplicate cash, or expose other users' receipts."""

import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import home_collections as home


class TestHomeCollections(unittest.TestCase):
	def test_options_only_reads_active_duty_and_currency(self):
		for duty in (None, "active-duty"):
			with (
				self.subTest(duty=duty),
				patch.object(home, "account", return_value="sales"),
				patch.object(home, "assigned_salesperson"),
				patch.object(frappe, "db", Mock(get_value=Mock(return_value=duty))) as db,
				patch.object(home.api, "settings", return_value=frappe._dict(company="Company")),
				patch.object(frappe, "get_cached_value", return_value="INR"),
				patch.object(home.api, "bootstrap") as dashboard,
			):
				self.assertEqual(home.options.__wrapped__(), {"duty": duty, "currency": "INR"})
				db.get_value.assert_called_once_with(
					"DSR Duty Session", {"account": "sales", "status": "Active"}, "name"
				)
				dashboard.assert_not_called()

	def setUp(self):
		self.stack = ExitStack()
		self.addCleanup(self.stack.close)
		self.stack.enter_context(
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		)
		self.stack.enter_context(
			patch.object(
				frappe,
				"throw",
				side_effect=lambda message, exc=frappe.ValidationError: (_ for _ in ()).throw(exc(message)),
			)
		)

	def test_profile_and_account_checks_are_required(self):
		with patch.object(home, "enabled", return_value=False), patch.object(home, "account_for") as auth:
			with self.assertRaises(frappe.PermissionError):
				home.account()
			auth.assert_not_called()
		with (
			patch.object(home, "enabled", return_value=True),
			patch.object(home, "account_for", return_value="sales") as auth,
		):
			self.assertEqual(home.account(lock=True), "sales")
			auth.assert_called_once_with(lock=True)

	def test_missing_mapping_never_falls_back_to_all_customers(self):
		with patch.object(frappe, "db", Mock(get_value=Mock(return_value=None))):
			with self.assertRaises(frappe.PermissionError):
				home.assigned_salesperson("sales")

	def test_collection_rejects_unassigned_or_disabled_customer_before_writing(self):
		for dealer in (
			frappe._dict(sales_person="other", disabled=0),
			frappe._dict(sales_person="mapped", disabled=1),
		):
			with (
				patch.object(home, "account", return_value="sales"),
				patch.object(home, "assigned_salesperson", return_value="mapped"),
				patch.object(home.api, "dealer", return_value=dealer),
				patch.object(home.api, "collect_payment_document") as write,
			):
				with self.assertRaises(frappe.PermissionError):
					home.collect.__wrapped__("Customer", 100, "Cash", "request-1234")
				write.assert_not_called()

	def test_collection_reuses_existing_service_for_authenticated_active_duty(self):
		doc = frappe._dict(name="duty", account="sales")
		with (
			patch.object(home, "account", return_value="sales") as auth,
			patch.object(home, "assigned_salesperson", return_value="mapped"),
			patch.object(home.api, "dealer", return_value=frappe._dict(sales_person="mapped")),
			patch.object(home.api, "repeated", return_value=None),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value="duty"))) as db,
			patch.object(home.api, "active", return_value=doc),
			patch.object(home.api, "collect_payment_document", return_value={"balance": 1200}) as write,
		):
			self.assertEqual(
				home.collect.__wrapped__("Customer", 200, "Cash", "request-1234")["balance"], 1200
			)
			auth.assert_called_once_with(lock=True)
			self.assertEqual(db.get_value.call_args.args[1], {"account": "sales", "status": "Active"})
			write.assert_called_once_with(
				doc, "Customer", 200, "Cash", "request-1234", transaction_reference="", remarks=""
			)

	def test_no_active_duty_records_a_direct_collection(self):
		direct = frappe._dict(name=None, account="sales", status="Direct")
		with (
			patch.object(home, "account", return_value="sales"),
			patch.object(home, "assigned_salesperson", return_value="mapped"),
			patch.object(home.api, "dealer", return_value=frappe._dict(sales_person="mapped")),
			patch.object(home.api, "repeated", return_value=None),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value=None))),
			patch.object(home, "collection_context", return_value=direct),
			patch.object(home.api, "collect_payment_document") as write,
		):
			home.collect.__wrapped__("Customer", 200, "Cash", "request-1234")
			write.assert_called_once_with(
				direct, "Customer", 200, "Cash", "request-1234", transaction_reference="", remarks=""
			)

	def test_successful_retry_after_duty_off_never_inserts_another_collection(self):
		prior = frappe._dict(
			name="receipt",
			account="sales",
			customer="Customer",
			amount=200,
			payment_method="Cash",
			duty="closed-duty",
		)
		with (
			patch.object(home, "account", return_value="sales"),
			patch.object(home, "assigned_salesperson", return_value="mapped"),
			patch.object(home.api, "dealer", return_value=frappe._dict(sales_person="mapped")),
			patch.object(home.api, "repeated", return_value=prior),
			patch.object(home, "collection_context", return_value=frappe._dict(name=None, account="sales")),
			patch.object(home.api, "cash_balance", return_value=1200),
			patch.object(home.api, "collect_payment_document") as write,
		):
			self.assertTrue(home.collect.__wrapped__("Customer", 200, "Cash", "request-1234")["duplicate"])
			write.assert_not_called()
			with self.assertRaises(frappe.ValidationError):
				home.collect.__wrapped__("Customer", 300, "Cash", "request-1234")

	def test_filters_always_keep_account_scope_and_use_bound_parameters(self):
		db = Mock()
		db.sql.side_effect = [[frappe._dict(count=0, total=0, cash=0, noncash=0)], []]
		with (
			patch.object(home, "account", return_value="sales"),
			patch.object(home.api, "settings", return_value=frappe._dict(company="Company")),
			patch.object(frappe, "get_cached_value", return_value="INR"),
			patch.object(frappe, "db", db),
		):
			home.collections.__wrapped__(
				search="' OR 1=1 --",
				payment_method="Cash",
				source="visit",
				from_date="2026-11-01",
				to_date="2026-11-21",
				start=50,
			)
		for call in db.sql.call_args_list:
			query, params = call.args
			self.assertIn("c.account=%s", query)
			self.assertEqual(params[0], "sales")
			self.assertNotIn("' OR 1=1 --", query)
			self.assertIn("%' OR 1=1 --%", params)
			self.assertIn("coalesce(c.activity,'')!=''", query)
			self.assertIn("2026-11-22 00:00:00", params)
		self.assertIn("c.verification_status!='Reversed'", db.sql.call_args_list[0].args[0])
		self.assertEqual(db.sql.call_args_list[1].args[1][-2:], (50, 50))

	def test_invalid_filter_does_not_query_collections(self):
		with patch.object(home, "account", return_value="sales"), patch.object(frappe, "db", Mock()) as db:
			with self.assertRaises(frappe.ValidationError):
				home.collections.__wrapped__(payment_method="Not a method")
			db.sql.assert_not_called()
