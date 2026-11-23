"""Photo deletion ownership, visit state, and scoped file-write checks."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api


class TestPhotoDelete(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_delete_attachment_preserves_metadata_and_restores_guard(self):
		for fail in (False, True):
			with self.subTest(file_delete_fails=fail):
				evidence = frappe._dict(
					name="photo",
					doctype="DSR Dealer Photo Evidence",
					activity="visit",
					duty="duty",
					account="user",
					photo="/private/files/shop.jpg",
					sha256="original-hash",
				)
				flags = frappe._dict(smart_dsr_evidence_write=False)
				with (
					patch.object(
						api,
						"activity_doc",
						return_value=(frappe._dict(name="visit"), frappe._dict(name="duty", account="user")),
					),
					patch.object(frappe, "get_doc", return_value=evidence),
					patch.object(frappe, "get_all", return_value=["file"]),
					patch.object(frappe, "flags", flags),
					patch.object(frappe, "session", frappe._dict(user="user")),
					patch.object(api, "save") as save,
					patch.object(api, "event") as event,
					patch.object(frappe, "delete_doc") as delete,
				):

					def remove(*args, **kwargs):
						self.assertTrue(flags.smart_dsr_evidence_write)
						if fail:
							raise RuntimeError("file failure")

					delete.side_effect = remove
					if fail:
						with self.assertRaises(RuntimeError):
							api._remove_visit_photo("visit", "photo")
					else:
						self.assertEqual(api._remove_visit_photo("visit", "photo"), {"deleted": "photo"})
					self.assertFalse(flags.smart_dsr_evidence_write)
					self.assertIsNone(evidence.photo)
					self.assertEqual(evidence.sha256, "original-hash")
					save.assert_called_once_with(evidence)
					delete.assert_called_once_with("File", "file", ignore_permissions=True)
					event.assert_called_once()

	def test_mismatched_photo_is_denied(self):
		for field in ("activity", "duty", "account"):
			evidence = frappe._dict(activity="visit", duty="duty", account="user")
			evidence[field] = "another"
			with (
				self.subTest(field=field),
				patch.object(
					api,
					"activity_doc",
					return_value=(frappe._dict(name="visit"), frappe._dict(name="duty", account="user")),
				),
				patch.object(frappe, "get_doc", return_value=evidence),
				patch.object(frappe, "throw", side_effect=self.throw),
				patch.object(frappe, "delete_doc") as delete,
			):
				with self.assertRaises(frappe.PermissionError):
					api._remove_visit_photo("visit", "photo")
				delete.assert_not_called()

	def test_completed_visit_is_denied(self):
		row = Mock(account="user", status="Completed", duty="duty")
		with (
			patch.object(frappe, "get_doc", return_value=row),
			patch.object(api, "active", return_value=frappe._dict(account="user")),
			patch.object(frappe, "throw", side_effect=self.throw),
			patch.object(frappe, "delete_doc") as delete,
		):
			with self.assertRaises(frappe.PermissionError):
				api._remove_visit_photo("visit", "photo")
			delete.assert_not_called()
