"""Dealer context in authorized cash ledgers, including reversed collections."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import admin


class TestLedgerDealers(unittest.TestCase):
	def test_collection_and_reversal_get_dealer_but_admin_cash_does_not(self):
		rows = [
			frappe._dict(account="sales@test", source_type="DSR Collection", source_name="collection-1"),
			frappe._dict(account="sales@test", source_type="DSR Cash Ledger", source_name="original-ledger"),
			frappe._dict(account="sales@test", source_type="User", source_name="sales@test"),
		]

		def get_all(dt, **kwargs):
			if dt == "DSR Cash Ledger":
				return [
					frappe._dict(
						name="original-ledger",
						account="sales@test",
						source_type="DSR Collection",
						source_name="collection-1",
					)
				]
			if dt == "DSR Collection":
				return [
					frappe._dict(
						name="collection-1",
						account="sales@test",
						customer="dealer-1",
						amount=500,
						collected_at="2026-11-20 12:00:00",
						payment_method="Cash",
						transaction_reference="receipt-1",
						verification_status="Recorded",
					)
				]
			return [frappe._dict(name="dealer-1", customer_name="Dealer One", mobile_no="9876543210")]

		with patch.object(admin.frappe, "get_all", side_effect=get_all):
			admin.ledger_dealer_details(rows)
		for row in rows[:2]:
			self.assertEqual(row.dealer_details["name"], "Dealer One")
			self.assertEqual(row.dealer_details["mobile_no"], "9876543210")
			self.assertEqual(row.collection_details["collection"], "collection-1")
			self.assertEqual(row.collection_details["amount"], 500)
		self.assertNotIn("dealer_details", rows[2])

	def test_cross_account_source_cannot_disclose_collection(self):
		row = frappe._dict(account="sales@test", source_type="DSR Collection", source_name="collection-1")

		def get_all(dt, **kwargs):
			if dt == "DSR Collection":
				return [frappe._dict(name="collection-1", account="other@test", customer="dealer-1")]
			return [frappe._dict(name="dealer-1", customer_name="Private Dealer")]

		with patch.object(admin.frappe, "get_all", side_effect=get_all):
			admin.ledger_dealer_details([row])
		self.assertNotIn("dealer_details", row)
		self.assertNotIn("collection_details", row)

	def test_non_collection_entries_do_not_fetch_dealers(self):
		with patch.object(admin.frappe, "get_all") as get_all:
			admin.ledger_dealer_details(
				[frappe._dict(account="sales@test", source_type="DSR Duty Session", source_name="duty-1")]
			)
			get_all.assert_not_called()
