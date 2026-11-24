"""Only an owner's pending, financially unlinked visit can be deleted."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import api


class TestDeletePendingVisit(unittest.TestCase):
	def setUp(self):
		self.row = frappe._dict(
			name="visit", duty="duty", account="user", customer="Dealer", status="Open", flags=frappe._dict()
		)
		self.row.reload = lambda: None
		self.doc = frappe._dict(name="duty", account="user", status="Active")
		for mock in (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(frappe, "session", frappe._dict(user="user")),
			patch.object(frappe, "get_doc", return_value=self.row),
			patch.object(api, "duty_doc", return_value=self.doc),
			patch.object(frappe, "throw", side_effect=self.throw),
		):
			mock.start()
			self.addCleanup(mock.stop)

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_pending_visit_deleted_with_photos_and_audit(self):
		with (
			patch.object(api, "locked_exists", return_value=False),
			patch.object(frappe, "get_all", return_value=["photo"]),
			patch.object(api, "_remove_visit_photo") as remove,
			patch.object(api, "save") as save,
			patch.object(api, "event") as audit,
		):
			self.assertEqual(api.delete_pending_visit("visit"), {"deleted": "visit"})
			self.assertEqual(self.row.status, "Deleted")
			remove.assert_called_once_with("visit", "photo")
			save.assert_called_once_with(self.row)
			audit.assert_called_once()
			self.assertEqual(api.delete_pending_visit("visit"), {"deleted": "visit"})
			save.assert_called_once()

	def test_completed_visit_and_other_owner_are_denied(self):
		for field, value in (("status", "Completed"), ("account", "other-user")):
			with self.subTest(field=field), patch.object(api, "save") as save:
				self.row.status, self.row.account = "Open", "user"
				self.row[field] = value
				with self.assertRaises(frappe.PermissionError):
					api.delete_pending_visit("visit")
				save.assert_not_called()

	def test_linked_financial_records_are_protected(self):
		for linked in ("DSR Collection", "Sales Order"):
			with (
				self.subTest(linked=linked),
				patch.object(api, "locked_exists", side_effect=lambda dt, where: dt == linked),
				patch.object(api, "save") as save,
				patch.object(api, "_remove_visit_photo") as remove,
			):
				with self.assertRaises(frappe.ValidationError):
					api.delete_pending_visit("visit")
				self.assertEqual(self.row.status, "Open")
				save.assert_not_called()
				remove.assert_not_called()

	def test_closed_duty_cannot_delete_pending_visit(self):
		self.doc.status = "Closed"
		with self.assertRaises(frappe.ValidationError):
			api.delete_pending_visit("visit")

	def test_visible_numbering_closes_gaps_after_deletion(self):
		with patch.object(
			frappe, "get_all", return_value=["original-visit-two", "original-visit-four"]
		) as query:
			self.assertEqual(api.visible_visit_number("original-visit-two", "duty"), 1)
			self.assertEqual(api.visible_visit_number("original-visit-four", "duty"), 2)
			self.assertIsNone(api.visible_visit_number("deleted-visit", "duty"))
			self.assertEqual(query.call_args.kwargs["filters"], {"duty": "duty", "status": ["!=", "Deleted"]})
