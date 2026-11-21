"""Cash issue/return accounting, carry-forward, and permission checks without live DB writes."""

import types
import unittest
from contextlib import ExitStack
from datetime import datetime
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin, api
from srv_erp.smart_dsr import cash_allocations as cash
from srv_erp.smart_dsr.policy import balance


class Row(frappe._dict):
	def reload(self):
		return self


class TestOpeningCash(unittest.TestCase):
	def setUp(self):
		self.stack = ExitStack()
		self.addCleanup(self.stack.close)
		# Standalone Home receipt accounting has its own SQL-backed test suite.
		self.stack.enter_context(patch.object(cash, "direct_pending", return_value=0))
		self.now = datetime(2026, 11, 20, 12)
		self.doc = None
		self.ledger = []
		self.audit_rows = {}
		self.audits = []

		def throw(message, error=None):
			raise (error or frappe.ValidationError)(message)

		self.throw = throw

		def insert(doctype, **values):
			row = Row(doctype=doctype, name="cash-" + str(len(self.ledger) + 1), posting_time=self.now)
			row.update(values)
			self.ledger.append(row)
			return row

		self.insert = insert

		def sql(query, params=None, **kwargs):
			if "`tabUser`" in query:
				return []
			if "`tabDSR Duty Session`" in query:
				return [Row(name=self.doc.name)] if self.doc else []
			if "coalesce(duty" in query:
				account, source_type = params[:2]
				anchor = params[2] if source_type == "DSR Duty Session" else None
				date_index = 3 if anchor else 2
				return [
					r
					for r in self.ledger
					if not r.duty
					and r.account == account
					and r.source_type == source_type
					and (not anchor or r.source_name == anchor)
					and r.transaction_type in ("Cash Advance", "Cash Handover")
					and (
						len(params) <= date_index
						or r.posting_time <= datetime.fromisoformat(params[date_index])
					)
				]
			return [
				r
				for r in self.ledger
				if r.duty == params[0]
				and r.transaction_type in ("Cash Advance", "Cash Handover", "Reversal")
				and (len(params) < 2 or r.posting_time <= datetime.fromisoformat(params[1]))
			]

		def initial(dt, filters, field, **kwargs):
			return next(
				(
					r.amount
					for r in self.ledger
					if r.transaction_type == "Opening"
					and not r.duty
					and (
						not filters.get("posting_time")
						or r.posting_time <= datetime.fromisoformat(filters["posting_time"][1])
					)
				),
				None,
			)

		fake = types.SimpleNamespace(
			db=types.SimpleNamespace(sql=sql, get_value=initial),
			get_doc=lambda *a, **kw: self.doc,
			throw=throw,
			_dict=Row,
		)

		def movements(doc, as_of=None, lock=False):
			return [
				r.amount
				for r in self.ledger
				if r.duty == doc.name
				and r.transaction_type != "Opening"
				and (not as_of or r.posting_time <= datetime.fromisoformat(as_of))
			]

		def initialize(user, amount, key, remarks):
			return insert(
				"DSR Cash Ledger",
				account=user,
				transaction_type="Opening",
				amount=amount,
				source_type="User",
				source_name=user,
			).name

		def movement(duty, kind, amount, key, why):
			return insert(
				"DSR Cash Ledger",
				account="sales@test",
				duty=duty,
				transaction_type=kind,
				amount=amount if kind == "Cash Advance" else -amount,
			).name

		def recalculate(doc):
			doc.closing_balance = float(balance(doc.opening_balance, movements(doc)))

		def audit(action, record, before, after, why, key, transaction):
			self.audits.append((before, after, transaction))
			row = Row(
				name="audit-" + str(len(self.audits)),
				record_id=record.name,
				transaction_id=transaction[1],
				outcome="Applied",
				reason=why,
			)
			self.audit_rows[key] = row
			return row

		for obj, name, replacement in [
			(cash, "frappe", fake),
			(admin, "frappe", fake),
			(admin, "require_finance", Mock()),
			(admin, "require_visible_account", Mock()),
			(admin, "prior", lambda key: self.audit_rows.get(key)),
			(admin, "audit", audit),
			(admin, "now_datetime", lambda: self.now),
			(api, "insert", insert),
			(api, "initialize_balance", initialize),
			(api, "cash_movement", movement),
			(api, "cash_movements", movements),
			(api, "recalculate", recalculate),
			(api, "save", Mock()),
		]:
			self.stack.enter_context(patch.object(obj, name, replacement))
		self.stack.enter_context(patch("frappe.throw", throw))

	def call(self, action, amount, key="request-0001", **kwargs):
		kwargs.setdefault("reason_text", "Cash allocation approved by admin.")
		return admin.record_opening_movement.__wrapped__("sales@test", action, amount, key, **kwargs)

	def initialized(self, value=1000):
		self.insert(
			"DSR Cash Ledger",
			account="sales@test",
			transaction_type="Opening",
			amount=value,
			source_type="User",
			source_name="sales@test",
		)

	def duty(self, opening=1000, closing=1000, status="Active", name="duty-1"):
		self.doc = Row(
			doctype="DSR Duty Session",
			name=name,
			account="sales@test",
			opening_balance=opening,
			closing_balance=closing,
			status=status,
		)

	def test_first_add_initializes_and_later_adds_returns_carry_once(self):
		self.call("add", 1000)
		self.call("add", 500, "request-0002")
		self.call("return", 200, "request-0003")
		self.assertEqual(cash.balances("sales@test"), {"opening_balance": 1300, "closing_balance": 1300})
		opening = cash.next_opening("sales@test", initial=1000)
		self.assertEqual(opening, 1300)
		self.duty(opening, opening)
		self.assertEqual(
			cash.balances("sales@test", self.doc), {"opening_balance": 1300, "closing_balance": 1300}
		)
		self.assertEqual(len(self.ledger), 3)

	def test_active_duty_cash_addition_does_not_double_count_and_returns_reduce_both_balances(self):
		self.duty()
		self.call("add", 500)
		self.assertEqual(self.doc.opening_balance, 1000)
		self.assertEqual(self.doc.closing_balance, 1500)
		self.call("return", 200, "request-0002")
		self.assertEqual(
			cash.balances("sales@test", self.doc), {"opening_balance": 1300, "closing_balance": 1300}
		)
		self.assertEqual(self.ledger[-1].transaction_type, "Cash Handover")
		self.assertEqual(self.ledger[-1].amount, -200)
		self.assertEqual(self.audits[-1][1]["closing_balance"], 1300)

	def test_finalized_history_unchanged_and_pending_cash_consumed_by_next_duty(self):
		self.duty(opening=1000, closing=1200, status="Finalized")
		previous = self.doc
		self.call("return", 200)
		self.call("add", 500, "request-0002")
		self.assertEqual(previous.closing_balance, 1200)
		self.assertEqual(previous.opening_balance, 1000)
		self.assertEqual(
			cash.balances("sales@test", previous), {"opening_balance": 1500, "closing_balance": 1500}
		)
		self.assertTrue(all(not row.duty and row.source_name == previous.name for row in self.ledger))
		opening = cash.next_opening("sales@test", previous)
		self.assertEqual(opening, 1500)
		self.duty(opening, opening, name="duty-2")
		self.assertEqual(cash.balances("sales@test", self.doc)["closing_balance"], 1500)
		self.doc.status = "Finalized"
		self.assertEqual(cash.next_opening("sales@test", self.doc), 1500)

	def test_over_return_invalid_values_and_uninitialized_return_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			self.call("return", 1)
		self.initialized()
		for amount in (1001, 0, -1, "not-money"):
			with self.assertRaises(frappe.ValidationError):
				self.call("return", amount)
		self.assertEqual(len(self.ledger), 1)

	def test_confirmed_balances_detect_stale_data_and_retries_do_not_duplicate_cash(self):
		self.initialized()
		with self.assertRaises(frappe.ValidationError):
			self.call("add", 100, expected_balance=999)
		with self.assertRaises(frappe.ValidationError):
			self.call("add", 100, expected_balance=1000, expected_opening=999)
		result = self.call("add", 100, expected_balance=1000, expected_opening=1000)
		repeat = self.call("add", 100, expected_balance=1000, expected_opening=1000)
		self.assertEqual(result["audit"], repeat["audit"])
		self.assertEqual(len(self.ledger), 2)

	def test_historical_pending_cash_respects_posting_date(self):
		self.initialized()
		self.call("add", 100)
		self.now = datetime(2026, 11, 21, 12)
		self.call("return", 50, "request-0002")
		self.assertEqual(
			cash.balances("sales@test", as_of="2026-11-20"),
			{"opening_balance": 1100, "closing_balance": 1100},
		)
		self.assertEqual(cash.balances("sales@test")["closing_balance"], 1050)

	def test_finance_permission_required_before_mutation(self):
		with patch.object(admin, "require_finance", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				self.call("add", 100)
		self.assertEqual(self.ledger, [])

	def test_reversed_advance_is_not_left_in_displayed_opening(self):
		self.duty()
		self.call("add", 100)
		advance = self.ledger[-1]
		self.insert(
			"DSR Cash Ledger",
			account="sales@test",
			duty=self.doc.name,
			transaction_type="Reversal",
			amount=-100,
			source_type="DSR Cash Ledger",
			source_name=advance.name,
		)
		self.assertEqual(
			cash.balances("sales@test", self.doc), {"opening_balance": 1000, "closing_balance": 1000}
		)

	def test_finalized_as_of_excludes_later_duty_movements(self):
		self.duty(opening=1000, closing=1500, status="Finalized")
		self.now = datetime(2026, 11, 21, 12)
		self.insert(
			"DSR Cash Ledger",
			account="sales@test",
			duty=self.doc.name,
			transaction_type="Cash Advance",
			amount=500,
		)
		self.assertEqual(cash.balances("sales@test", self.doc, as_of="2026-11-20")["closing_balance"], 1000)

	def test_exact_closing_balance_can_be_returned(self):
		self.initialized()
		self.call("return", 1000)
		self.assertEqual(cash.balances("sales@test"), {"opening_balance": 0, "closing_balance": 0})

	def test_return_reversal_restores_both_displayed_balances(self):
		self.duty()
		self.call("return", 200)
		returned = self.ledger[-1]
		self.assertEqual(
			cash.balances("sales@test", self.doc), {"opening_balance": 800, "closing_balance": 800}
		)
		self.insert(
			"DSR Cash Ledger",
			account="sales@test",
			duty=self.doc.name,
			transaction_type="Reversal",
			amount=200,
			source_type="DSR Cash Ledger",
			source_name=returned.name,
		)
		self.assertEqual(
			cash.balances("sales@test", self.doc), {"opening_balance": 1000, "closing_balance": 1000}
		)

	def test_opening_addition_limit_allows_ten_lakhs_and_rejects_more(self):
		with self.assertRaises(frappe.ValidationError):
			self.call("add", "1000000.01")
		self.assertEqual(self.ledger, [])
		self.call("add", "1000000")
		self.assertEqual(cash.balances("sales@test")["closing_balance"], 1000000)

	def test_cash_reason_is_required_and_preserved_in_audit(self):
		for value in (None, "", "   ", "x" * 2001):
			with self.assertRaises(frappe.ValidationError):
				self.call("add", 100, reason_text=value)
		self.assertEqual(self.ledger, [])
		self.call("add", 100, reason_text="Cash issued for dealer visits.")
		self.assertEqual(self.audit_rows["request-0001"].reason, "Cash issued for dealer visits.")
		with self.assertRaises(frappe.ValidationError):
			self.call("return", 10, "return-reason-1", reason_text=" ")
		self.call("return", 10, "return-reason-1", reason_text="Unused cash returned after duty.")
		self.assertEqual(self.ledger[-1].remarks, "Unused cash returned after duty.")
