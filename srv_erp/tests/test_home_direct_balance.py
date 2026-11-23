"""Exercise standalone balance SQL on an isolated in-memory ledger."""

import sqlite3
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin, api, home_collections
from srv_erp.smart_dsr import cash_allocations as cash


class TestHomeDirectBalance(unittest.TestCase):
	def setUp(self):
		self.connection = sqlite3.connect(":memory:")
		self.addCleanup(self.connection.close)
		self.connection.executescript("""
			create table `tabDSR Cash Ledger` (name text, account text, duty text,
				transaction_type text, amount real, source_type text, source_name text, posting_time text);
			create table `tabDSR Duty Session` (name text, account text, creation text);
		""")

		def sql(query, params=(), as_dict=False, **kwargs):
			cursor = self.connection.execute(query.replace("%s", "?").replace(" for update", ""), params)
			rows = cursor.fetchall()
			return (
				[frappe._dict(zip([c[0] for c in cursor.description], row, strict=True)) for row in rows]
				if as_dict
				else rows
			)

		self.db = Mock(sql=Mock(side_effect=sql), get_value=Mock(return_value=1000))
		stub = patch.object(frappe, "db", self.db)
		stub.start()
		self.addCleanup(stub.stop)

	def entry(
		self, name, amount, time, source="DSR Collection", reference="receipt", account="sales", duty=None
	):
		self.connection.execute(
			"insert into `tabDSR Cash Ledger` values (?,?,?,?,?,?,?,?)",
			(
				name,
				account,
				duty,
				"Reversal" if source == "DSR Cash Ledger" else "Dealer Cheque Collection",
				amount,
				source,
				reference,
				time,
			),
		)

	def duty(self, name, time, closing=1500):
		self.connection.execute("insert into `tabDSR Duty Session` values (?,?,?)", (name, "sales", time))
		return frappe._dict(name=name, account="sales", status="Finalized", closing_balance=closing)

	def test_direct_receipts_increase_balance_and_first_opening_once(self):
		self.entry("one", 500, "2026-11-21 08:00:00")
		self.entry("other", 900, "2026-11-21 08:00:00", account="other-user")
		self.assertEqual(cash.balances("sales")["closing_balance"], 1500)
		self.assertEqual(cash.next_opening("sales", initial=1000), 1500)
		doc = self.duty("first", "2026-11-21 09:00:00")
		self.assertEqual(cash.balances("sales", doc)["closing_balance"], 1500)
		self.assertEqual(cash.next_opening("sales", doc), 1500)

	def test_collection_before_opening_initialization_still_has_a_balance(self):
		self.db.get_value.return_value = None
		self.entry("one", 500, "2026-11-21 08:00:00")
		self.assertEqual(cash.balances("sales")["closing_balance"], 500)

	def test_between_duty_receipts_and_reversals_do_not_rewrite_prior_snapshots(self):
		previous = self.duty("first", "2026-11-20 09:00:00", 1000)
		self.entry("one", 500, "2026-11-21 08:00:00")
		self.assertEqual(cash.balances("sales", previous)["closing_balance"], 1500)
		self.assertEqual(cash.direct_pending("sales", previous, as_of="2026-11-20"), 0)
		next_duty = self.duty("next", "2026-11-21 09:00:00", 1500)
		self.entry("reverse", -500, "2026-11-22 08:00:00", "DSR Cash Ledger", "one")
		self.assertEqual(cash.balances("sales", next_duty)["closing_balance"], 1000)
		self.assertEqual(cash.direct_pending("sales", previous), 500)
		self.assertEqual(cash.next_opening("sales", next_duty), 1000)

	def test_collection_context_does_not_create_or_reopen_duties(self):
		for status in (None, "Finalized", "Closed", "Active"):
			doc = frappe._dict(name="duty", account="sales", status=status) if status else None
			with patch.object(cash, "latest_duty", return_value=doc), patch.object(api, "insert") as create:
				context = home_collections.collection_context("sales")
				self.assertEqual(context.name, "duty" if status in ("Active", "Closed") else None)
				self.assertEqual(context.account, "sales")
				create.assert_not_called()


class TestDirectReceiptServices(unittest.TestCase):
	def test_all_payment_methods_save_without_a_duty_and_sync_dues(self):
		for method in ("Cash", "UPI", "Bank Transfer", "Cheque"):
			with self.subTest(method=method), ExitStack() as stack:
				context = frappe._dict(name=None, account="sales", status="Direct")
				row = frappe._dict(name="receipt", doctype="DSR Collection")
				for obj, name, replacement in (
					(frappe, "db", Mock()),
					(api, "repeated", Mock(return_value=None)),
					(api, "dealer", Mock()),
					(api, "key", Mock(return_value="stable-key")),
					(api, "now_datetime", Mock(return_value="2026-11-21 10:00:00")),
					(api, "cash_balance", Mock(return_value=500)),
					(api, "event", Mock()),
				):
					stack.enter_context(patch.object(obj, name, replacement))
				create = stack.enter_context(patch.object(api, "insert", return_value=row))
				ledger = stack.enter_context(patch.object(api, "ledger"))
				receipt = stack.enter_context(patch("srv_erp.overdues.sync_collection_receipt"))
				result = api.collect_payment_document(
					context, "Dealer", 500, method, "receipt-key", transaction_reference="REF-1"
				)
				self.assertEqual(result["balance"], 500)
				self.assertIsNone(create.call_args.kwargs["duty"])
				self.assertEqual(create.call_args.kwargs["payment_method"], method)
				receipt.assert_called_once_with(row)
				self.assertEqual(ledger.call_args.args[2], 500)

	def test_standalone_reversal_updates_current_balance_and_restores_dues(self):
		for current in (None, "current-duty"):
			with self.subTest(current=current), ExitStack() as stack:
				context = frappe._dict(
					name=current, account="sales", status="Active" if current else "Direct"
				)
				row = frappe._dict(
					name="receipt",
					doctype="DSR Collection",
					duty=None,
					account="sales",
					amount=500,
					verification_status="Recorded",
					payment_entry=None,
				)
				for obj, name, replacement in (
					(
						frappe,
						"db",
						Mock(get_value=Mock(return_value="original"), exists=Mock(return_value=False)),
					),
					(home_collections, "collection_context", Mock(return_value=context)),
					(api, "cash_balance", Mock(side_effect=[1500, 1000])),
					(api, "save", Mock()),
					(admin, "audit", Mock()),
					(admin, "response_audit", Mock()),
				):
					stack.enter_context(patch.object(obj, name, replacement))
				restore = stack.enter_context(patch("srv_erp.overdues.reverse_collection_receipt"))
				ledger = stack.enter_context(
					patch.object(api, "ledger", return_value=frappe._dict(name="reversal"))
				)
				recalculate = stack.enter_context(patch.object(api, "recalculate"))
				admin.reverse_direct_collection(row, "Cheque returned", "reverse-request")
				restore.assert_called_once_with(row)
				self.assertEqual(ledger.call_args.args[2], -500)
				self.assertEqual(row.verification_status, "Reversed")
				self.assertEqual(recalculate.call_count, int(bool(current)))
