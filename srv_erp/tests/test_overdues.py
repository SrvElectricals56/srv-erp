"""Manual dues validation, permission scoping and duplicate request protection."""

import unittest
from datetime import date
from unittest.mock import Mock, patch

import frappe

from srv_erp import overdues
from srv_erp.srv_erp.doctype.dealer_overdue.dealer_overdue import DealerOverdue


class TestOverdues(unittest.TestCase):
	def setUp(self):
		for context in (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(frappe, "session", frappe._dict(user="accountant")),
			patch.object(frappe, "throw", side_effect=self.throw),
			patch.object(frappe, "get_system_settings", return_value="Banker's Rounding"),
		):
			context.start()
			self.addCleanup(context.stop)

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_manual_received_reduces_balance_and_keeps_paid_records(self):
		base = dict(
			customer="C-1",
			customer_name="Dealer",
			entry_date="2026-11-01",
			due_date="2026-11-10",
			amount=1000,
		)
		rows = overdues.normalize_rows(
			[
				dict(base, name="DUE-1", amount_received=250, outstanding_amount=750),
				dict(base, name="DUE-2", amount_received=1000, outstanding_amount=0),
				dict(base, name="DUE-3", amount_received=0, outstanding_amount=1000, due_date="2026-11-19"),
			],
			date(2026, 11, 19),
		)
		self.assertEqual(len(rows), 3)
		self.assertEqual(sum(row["overdue"] for row in rows), 750)
		self.assertEqual(sum(row["outstanding"] for row in rows), 1750)
		self.assertTrue(all(row["voucher_type"] == "Dealer Overdue" for row in rows))

	def test_only_manual_records_are_queried_with_get_list(self):
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(overdues, "company_name", return_value="SRV Electricals"),
			patch.object(overdues, "nowdate", return_value="2026-11-19"),
			patch.object(frappe, "get_cached_value", return_value="INR"),
			patch.object(frappe.utils, "now", return_value="2026-11-19 10:00:00"),
			patch.object(frappe, "get_list", return_value=[]) as query,
		):
			result = overdues.get_overdues(customer="C-1", territory="Punjab", sales_person="Sales User")
			self.assertEqual(query.call_args.args, ("Dealer Overdue",))
			self.assertEqual(query.call_args.kwargs["filters"]["state"], "Active")
			self.assertEqual(query.call_args.kwargs["filters"]["customer"], "C-1")
			self.assertEqual(query.call_args.kwargs["filters"]["company"], "SRV Electricals")
			self.assertEqual(result["currency"], "INR")
			self.assertTrue(result["can_create"])

	def test_no_permission_or_guest_cannot_read_or_create(self):
		with (
			patch.object(frappe, "has_permission", return_value=False),
			patch.object(frappe, "get_list") as query,
		):
			with self.assertRaises(frappe.PermissionError):
				overdues.get_overdues()
			with self.assertRaises(frappe.PermissionError):
				overdues.create_overdue({}, "test")
			query.assert_not_called()
		with (
			patch.object(frappe, "session", frappe._dict(user="Guest")),
			self.assertRaises(frappe.PermissionError),
		):
			overdues.get_overdues()

	def test_future_ageing_date_rejected(self):
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(overdues, "nowdate", return_value="2026-11-19"),
			self.assertRaises(frappe.ValidationError),
		):
			overdues.get_overdues("2026-11-20")

	def test_duplicate_request_returns_existing_record_without_insert(self):
		db = Mock(get_value=Mock(return_value="DUE-1"))
		doc = Mock()
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(frappe, "db", db),
			patch.object(frappe, "get_doc", return_value=doc),
		):
			self.assertEqual(overdues.create_overdue({"amount": 1000}, "same-request"), "DUE-1")
			doc.check_permission.assert_called_once_with("read")
			doc.insert.assert_not_called()

	def test_create_allows_only_manual_input_fields(self):
		doc = Mock()
		doc.name = "DUE-2"
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value=None))),
			patch.object(frappe, "get_doc", return_value=doc) as make,
		):
			self.assertEqual(
				overdues.create_overdue(
					{
						"customer": "C-1",
						"amount": 1000,
						"amount_received": 100,
						"outstanding_amount": 999999,
						"company": "OTHER",
						"state": "Cancelled",
					},
					"new-request",
				),
				"DUE-2",
			)
			payload = make.call_args.args[0]
			self.assertEqual(payload["state"], "Active")
			self.assertNotIn("company", payload)
			self.assertNotIn("outstanding_amount", payload)
			doc.insert.assert_called_once_with()

	def validate_record(self, **values):
		doc = frappe._dict(
			customer="C-1",
			amount=1000,
			amount_received=200,
			entry_date="2026-11-01",
			due_date="2026-10-01",
			state="Active",
		)
		doc.update(values)
		doc.set = lambda key, value: doc.update({key: value})
		doc.precision = lambda field: 2

		def value(doctype, *args):
			return (
				"SRV Electricals" if doctype == "Company" else ("Dealer", "Punjab", "Allocated Sales Person")
			)

		with (
			patch.object(frappe, "db", Mock(get_value=Mock(side_effect=value))),
			patch.object(frappe, "get_cached_value", return_value="INR"),
			patch.object(frappe, "has_permission", return_value=True),
			patch("srv_erp.srv_erp.doctype.dealer_overdue.dealer_overdue.nowdate", return_value="2026-11-19"),
		):
			DealerOverdue.validate(doc)
		return doc

	def test_controller_computes_balance_and_fixes_company(self):
		doc = self.validate_record(company="OTHER", outstanding_amount=99999)
		self.assertEqual(doc.company, "SRV Electricals")
		self.assertEqual(doc.outstanding_amount, 800)
		self.assertEqual(doc.sales_person, "Allocated Sales Person")

	def test_invalid_amounts_are_rejected(self):
		for values in (
			{"amount": 0},
			{"amount": -1},
			{"amount_received": -1},
			{"amount_received": 1001},
			{"amount": float("nan")},
			{"amount_received": float("inf")},
		):
			with self.subTest(values=values), self.assertRaises(frappe.ValidationError):
				self.validate_record(**values)

	def test_receipt_applies_oldest_first_and_rejects_excess_before_any_save(self):
		def entry(name, balance):
			doc = frappe._dict(
				name=name,
				customer="C-1",
				company="SRV Electricals",
				entry_date="2026-11-01",
				state="Active",
				outstanding_amount=balance,
				amount_received=0,
			)
			doc.check_permission = Mock()
			doc.save = Mock()
			return doc

		first, second = entry("DUE-1", 100), entry("DUE-2", 200)
		receipt = frappe._dict(customer="C-1", amount=150, received_date="2026-11-19")
		receipt.precision = lambda field: 2
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(overdues, "get_dealer_details"),
			patch.object(overdues, "company_name", return_value="SRV Electricals"),
			patch.object(overdues, "nowdate", return_value="2026-11-19"),
			patch.object(frappe, "db", Mock()),
			patch.object(frappe, "get_cached_value", return_value="INR"),
			patch.object(frappe, "get_list", return_value=["DUE-1", "DUE-2"]),
			patch.object(
				frappe, "get_doc", side_effect=lambda dt, name, **kw: first if name == "DUE-1" else second
			),
		):
			overdues.apply_received_amount(receipt)
			self.assertEqual(receipt.dues_amount, 300)
			self.assertEqual(receipt.leftover_dues, 150)
			self.assertEqual(receipt.balance_snapshot_available, 1)
			self.assertEqual(first.amount_received, 100)
			self.assertEqual(second.amount_received, 50)
			self.assertEqual(
				frappe.parse_json(receipt.allocations),
				[{"entry": "DUE-1", "amount": 100}, {"entry": "DUE-2", "amount": 50}],
			)
			first.save.reset_mock()
			second.save.reset_mock()
			receipt.amount = 1000
			with self.assertRaises(frappe.ValidationError):
				overdues.apply_received_amount(receipt)
			first.save.assert_not_called()
			second.save.assert_not_called()

	def test_receipt_retry_does_not_deduct_twice(self):
		doc = Mock(customer="C-1")
		doc.name = "DUE-REC-1"
		with (
			patch.object(frappe, "has_permission", return_value=True),
			patch.object(overdues, "get_dealer_details"),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value="DUE-REC-1"))),
			patch.object(frappe, "get_doc", return_value=doc),
		):
			self.assertEqual(overdues.record_received_amount("C-1", 100, "2026-11-19", "retry"), "DUE-REC-1")
			doc.insert.assert_not_called()

	def test_existing_receipt_snapshot_undoes_its_own_and_later_balance_updates(self):
		receipt = frappe._dict(
			name="REC-1",
			customer="C-1",
			creation="2026-11-10 10:00:00",
			received_date="2026-11-10",
			amount=200,
			allocations='[{"entry":"DUE-1","amount":200}]',
		)
		entry = frappe._dict(
			name="DUE-1",
			customer="C-1",
			company="SRV Electricals",
			creation="2026-11-01 10:00:00",
			entry_date="2026-11-01",
			state="Active",
			amount=1000,
			amount_received=500,
		)
		versions = [
			frappe._dict(docname="DUE-1", data='{"changed":[["amount_received","₹ 400.00","₹ 500.00"]]}'),
			frappe._dict(docname="DUE-1", data='{"changed":[["amount_received","₹ 200.00","₹ 400.00"]]}'),
		]

		def query(doctype, **kwargs):
			return {"Dealer Overdue Receipt": [receipt], "Dealer Overdue": [entry], "Version": versions}[
				doctype
			]

		with (
			patch("srv_erp.smart_dsr.admin_permissions.require_admin"),
			patch.object(overdues, "company_name", return_value="SRV Electricals"),
			patch.object(frappe, "get_all", side_effect=query),
			patch.object(frappe, "db", Mock(get_single_value=Mock(return_value="#,###.##"))) as db,
		):
			self.assertEqual(
				overdues.backfill_receipt_balance_snapshots(), {"recovered": 1, "unavailable": 0}
			)
			values = db.set_value.call_args.args[2]
			self.assertEqual(values["dues_amount"], 800)
			self.assertEqual(values["leftover_dues"], 600)


def live_smoke():
	"""Test create/retry/edit/cancel against a real dealer, then roll back every write."""
	from datetime import timedelta
	from uuid import uuid4

	frappe.set_user("Administrator")
	customer = frappe.db.get_value("Customer", {}, "name")
	if not customer:
		return {"skipped": "No Customer exists for rollback-only validation."}
	request = "overdues-test-" + str(uuid4())
	try:
		name = overdues.create_overdue(
			{
				"customer": customer,
				"amount": 1000,
				"amount_received": 200,
				"entry_date": frappe.utils.nowdate(),
				"due_date": str(frappe.utils.getdate() - timedelta(days=5)),
				"remarks": "Rollback-only validation",
			},
			request,
		)
		assert overdues.create_overdue({}, request) == name
		doc = frappe.get_doc("Dealer Overdue", name)
		doc.amount_received = 300
		doc.save()
		rows = overdues.get_overdues(customer=customer)["rows"]
		assert next(row for row in rows if row["voucher_no"] == name)["outstanding"] == 700
		receipt = overdues.record_received_amount(customer, 100, frappe.utils.nowdate(), request + "-receipt")
		assert (
			overdues.record_received_amount(customer, 100, frappe.utils.nowdate(), request + "-receipt")
			== receipt
		)
		allocation = frappe.parse_json(frappe.get_doc("Dealer Overdue Receipt", receipt).allocations)
		assert sum(row["amount"] for row in allocation) == 100
		assert frappe.db.get_value("Dealer Overdue", name, "outstanding_amount") <= 700
		doc.reload()
		doc.state = "Cancelled"
		doc.save()
		assert all(row["voucher_no"] != name for row in overdues.get_overdues(customer=customer)["rows"])
		return {"create_retry_edit_cancel": "passed", "writes": "rolled back"}
	finally:
		frappe.db.rollback()


def live_collection_smoke():
	"""Verify DSR receipt deduction, retry and reversal, then roll back test writes."""
	from uuid import uuid4

	from srv_erp.smart_dsr import api

	frappe.set_user("Administrator")
	sources = frappe.get_all("DSR Collection", fields=["account", "duty", "customer"], limit_page_length=1)
	if not sources:
		return {"skipped": "No collection available as a rollback-only test template."}
	source = sources[0]
	try:
		overdues.create_overdue(
			{
				"customer": source.customer,
				"amount": 2000,
				"entry_date": frappe.utils.nowdate(),
				"due_date": frappe.utils.nowdate(),
			},
			"auto-dsr-test-" + str(uuid4()),
		)
		before = sum(row["outstanding"] for row in overdues.get_overdues(customer=source.customer)["rows"])
		collection = api.insert(
			"DSR Collection",
			account=source.account,
			duty=source.duty,
			customer=source.customer,
			amount=before + 100,
			payment_method="Cash",
			collected_at=frappe.utils.now_datetime(),
			verification_status="Recorded",
			request_key="auto-dsr-test-" + str(uuid4()),
		)
		receipt = overdues.sync_collection_receipt(collection)
		doc = frappe.get_doc("Dealer Overdue Receipt", receipt)
		assert doc.applied_amount == before and doc.unapplied_amount == 100
		assert doc.dues_amount == before and doc.leftover_dues == 0 and doc.balance_snapshot_available == 1
		assert sum(row["outstanding"] for row in overdues.get_overdues(customer=source.customer)["rows"]) == 0
		assert overdues.sync_collection_receipt(collection) == receipt
		overdues.reverse_collection_receipt(collection)
		assert (
			sum(row["outstanding"] for row in overdues.get_overdues(customer=source.customer)["rows"])
			== before
		)
		assert frappe.db.get_value("Dealer Overdue Receipt", receipt, "reversed") == 1
		return {"DSR_deduction_retry_surplus_reversal": "passed", "writes": "rolled back"}
	finally:
		frappe.db.rollback()
