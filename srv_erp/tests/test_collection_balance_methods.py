"""Every accepted payment method credits closing balance and records a receipt."""

import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin, api


class TestCollectionBalanceMethods(unittest.TestCase):
	def test_legacy_cheque_reversal_restores_overdue_receipt_without_a_ledger_entry(self):
		row = frappe._dict(
			name="cheque",
			doctype="DSR Collection",
			duty="duty",
			verification_status="Recorded",
			payment_entry=None,
		)
		row.set = lambda key, value: row.update({key: value})
		duty = Mock(status="Active", closing_balance=1000)
		with ExitStack() as stack:
			for obj, name, replacement in (
				(admin, "require_finance", Mock()),
				(admin, "reason", Mock(return_value="Cheque returned")),
				(admin, "locked_record", Mock(return_value=row)),
				(admin, "prior", Mock(return_value=None)),
				(admin, "audit", Mock()),
				(admin, "response_audit", Mock()),
				(frappe, "get_doc", Mock(return_value=duty)),
				(frappe, "db", Mock(get_value=Mock(return_value=None))),
				(api, "cash_balance", Mock(return_value=1000)),
				(api, "save", Mock()),
				(api, "recalculate", Mock()),
			):
				stack.enter_context(patch.object(obj, name, replacement))
			restore = stack.enter_context(patch("srv_erp.overdues.reverse_collection_receipt"))
			admin.reverse_financial.__wrapped__("collections", "cheque", "Cheque returned", "reverse-cheque")
			restore.assert_called_once_with(row)
			self.assertEqual(row.verification_status, "Reversed")

	def test_cheque_ledger_reversal_restores_dues_and_debits_closing_balance(self):
		duty = frappe._dict(name="duty", account="sales", status="Active", flags=frappe._dict())
		duty.reload = Mock()
		original = frappe._dict(
			name="movement",
			doctype="DSR Cash Ledger",
			duty="duty",
			transaction_type="Dealer Cheque Collection",
			source_type="DSR Collection",
			source_name="cheque",
			amount=200,
		)
		collection = frappe._dict(name="cheque", payment_entry=None)
		with ExitStack() as stack:
			stack.enter_context(patch.object(api, "require_finance"))
			stack.enter_context(patch.object(frappe, "db", Mock(exists=Mock(return_value=False))))
			stack.enter_context(patch.object(frappe, "get_doc", side_effect=[duty, original, collection]))
			stack.enter_context(patch.object(api, "repeated", return_value=None))
			stack.enter_context(patch.object(api, "save"))
			ledger = stack.enter_context(
				patch.object(api, "ledger", return_value=frappe._dict(name="reversal"))
			)
			restore = stack.enter_context(patch("srv_erp.overdues.reverse_collection_receipt"))
			api.cash_movement.__wrapped__(
				"duty", "Reversal", 0, "reverse-cheque", "Cheque returned", "movement"
			)
			restore.assert_called_once_with(collection)
			self.assertEqual(collection.verification_status, "Reversed")
			self.assertEqual(ledger.call_args.args[2], -200)

	def test_all_methods_create_receipts_and_credit_the_ledger(self):
		for method, kind, balance in [
			("Cash", "Dealer Cash Collection", 1200),
			("UPI", "Dealer Digital Collection", 1200),
			("Bank Transfer", "Dealer Digital Collection", 1200),
			("Cheque", "Dealer Cheque Collection", 1200),
		]:
			with self.subTest(method=method), ExitStack() as stack:
				doc = frappe._dict(name="duty", account="sales", status="Active")
				row = frappe._dict(doctype="DSR Collection", name="receipt")
				stack.enter_context(patch.object(frappe, "db", Mock()))
				stack.enter_context(patch.object(api, "repeated", return_value=None))
				stack.enter_context(patch.object(api, "dealer"))
				stack.enter_context(patch.object(api, "key", return_value="key"))
				stack.enter_context(patch.object(api, "now_datetime", return_value="2026-11-21 12:00:00"))
				insert = stack.enter_context(patch.object(api, "insert", return_value=row))
				ledger = stack.enter_context(patch.object(api, "ledger"))
				stack.enter_context(patch.object(api, "event"))
				stack.enter_context(
					patch.object(
						api, "cash_balance", side_effect=lambda doc: 1000 + (200 if ledger.called else 0)
					)
				)
				receipt = stack.enter_context(patch("srv_erp.overdues.sync_collection_receipt"))
				result = api.collect_payment_document(
					doc, "Dealer", 200, method, "test-request", transaction_reference="REF-123"
				)
				self.assertEqual(result, {"name": "receipt", "balance": balance})
				self.assertEqual(insert.call_args.kwargs["payment_method"], method)
				self.assertEqual(insert.call_args.kwargs["amount"], 200)
				receipt.assert_called_once_with(row)
				if kind:
					ledger.assert_called_once_with(
						doc, kind, 200, "DSR Collection", "receipt", "collection:receipt"
					)
				else:
					ledger.assert_not_called()

	def test_retry_does_not_credit_any_payment_method_twice(self):
		for method in ("Cash", "UPI", "Bank Transfer", "Cheque"):
			with (
				self.subTest(method=method),
				patch.object(api, "repeated", return_value=frappe._dict(name="existing")),
				patch.object(api, "cash_balance", return_value=1500),
				patch.object(api, "insert") as insert,
				patch.object(api, "ledger") as ledger,
				patch("srv_erp.overdues.sync_collection_receipt"),
			):
				self.assertEqual(
					api.collect_payment_document(
						frappe._dict(status="Active", name="duty", account="sales"),
						"Dealer",
						200,
						method,
						"retry-key",
					)["name"],
					"existing",
				)
				insert.assert_not_called()
				ledger.assert_not_called()
