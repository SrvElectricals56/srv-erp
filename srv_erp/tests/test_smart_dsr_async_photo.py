"""The image is durable before GPS arrives; location attachment stays scoped."""

import base64
import hashlib
import io
import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe
from PIL import Image

from srv_erp.smart_dsr import api


class TestAsyncPhoto(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)
		self.stamp = datetime(2026, 11, 18, 10)
		self.row = frappe._dict(name="visit")
		self.doc = frappe._dict(name="duty", account="user")
		self.photo = frappe._dict(
			name="photo",
			activity="visit",
			duty="duty",
			account="user",
			photo="/private/files/shop.jpg",
			received_at=self.stamp,
			capture_source="Browser camera pending location",
		)

	def test_upload_succeeds_without_gps_and_does_not_start_location_timer(self):
		image = io.BytesIO()
		Image.new("RGB", (120, 120), "blue").save(image, format="JPEG")
		stored = io.BytesIO()
		Image.new("RGB", (120, 120), "blue").save(stored, format="JPEG", quality=90)
		stored_bytes = stored.getvalue()
		self.assertNotEqual(image.getvalue(), stored_bytes)
		file = Mock(get_content=Mock(return_value=stored_bytes))
		cache = Mock()
		cache.get_value.return_value = {"activity": "visit", "account": "user"}
		evidence = frappe._dict(name="photo", doctype="DSR Dealer Photo Evidence")
		self.row.customer = "dealer"

		def insert_evidence(doctype, **values):
			evidence.update(doctype=doctype, **values)
			return evidence

		with (
			patch.object(api, "activity_doc", return_value=(self.row, self.doc)),
			patch.object(frappe, "cache", return_value=cache),
			patch.object(frappe, "flags", frappe._dict()),
			patch.object(api, "now_datetime", return_value=self.stamp),
			patch("frappe.utils.get_system_timezone", return_value="Asia/Kolkata"),
			patch.object(api, "insert", side_effect=insert_evidence),
			patch(
				"frappe.utils.file_manager.save_file",
				return_value=frappe._dict(file_url="/private/files/shop.jpg"),
			),
			patch.object(api, "save") as save,
			patch.object(frappe, "get_all", return_value=[evidence]),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value="private-file"))),
			patch.object(frappe, "get_doc", return_value=file),
			patch.object(frappe, "session", frappe._dict(user="user")),
			patch.object(api, "location") as gps,
			patch.object(api, "finish_browser_photo_location") as finish,
		):
			result = api.browser_photo("visit", "challenge", base64.b64encode(image.getvalue()).decode())
			self.assertEqual(result["photo"], "/private/files/shop.jpg")
			self.assertEqual(result["capture_source"], "Browser camera pending location")
			self.assertEqual(self.row.arrived_at, self.stamp)
			self.assertEqual(evidence.sha256, hashlib.sha256(stored_bytes).hexdigest())
			save.assert_any_call(evidence)
			self.assertEqual(api.order_return_reference("visit")["customer"], "dealer")
			frappe.db.get_value.assert_called_with(
				"File",
				{
					"file_url": "/private/files/shop.jpg",
					"is_private": 1,
					"attached_to_doctype": "DSR Dealer Photo Evidence",
					"attached_to_name": "photo",
				},
				"name",
			)
			file.get_content.return_value = image.getvalue()
			self.assertFalse(api.valid_photo("visit", "user"))
			file.get_content.side_effect = FileNotFoundError
			self.assertFalse(api.valid_photo("visit", "user"))
			gps.assert_not_called()
			finish.assert_not_called()

	def test_location_attaches_once_and_returns_refreshed_details(self):
		point = dict(latitude=28, longitude=77, accuracy=10)
		with (
			patch.object(api, "activity_doc", return_value=(self.row, self.doc)),
			patch.object(frappe, "get_doc", return_value=self.photo),
			patch.object(api, "now_datetime", return_value=self.stamp + timedelta(seconds=5)),
			patch.object(api, "location", return_value=point),
			patch.object(api, "save"),
			patch.object(api, "finish_browser_photo_location") as finish,
			patch.object(api, "visit_details", return_value={"visit": "details"}),
		):
			self.assertEqual(api.browser_photo_location("visit", "photo", point), {"visit": "details"})
			self.assertEqual(self.photo.capture_source, "Browser camera")
			self.assertEqual(self.photo.latitude, 28)
			api.browser_photo_location("visit", "photo", point)
			finish.assert_called_once_with(self.row, self.doc, self.photo, point)

	def test_foreign_removed_and_expired_photos_cannot_receive_location(self):
		for change, text in (
			({"account": "other"}, "does not belong"),
			({"photo": ""}, "does not belong"),
			({"received_at": self.stamp - timedelta(minutes=3)}, "expired"),
		):
			photo = frappe._dict(self.photo)
			photo.update(change)
			with (
				self.subTest(change=change),
				patch.object(api, "activity_doc", return_value=(self.row, self.doc)),
				patch.object(frappe, "get_doc", return_value=photo),
				patch.object(api, "now_datetime", return_value=self.stamp),
				patch.object(
					frappe,
					"throw",
					side_effect=lambda message, *args: (_ for _ in ()).throw(frappe.ValidationError(message)),
				),
				patch.object(api, "save") as save,
			):
				with self.assertRaisesRegex(frappe.ValidationError, text):
					api.browser_photo_location("visit", "photo", {})
				save.assert_not_called()

	def test_pending_photo_location_blocks_submission(self):
		self.row.update(duty="duty", account="user", status="Open")
		with (
			patch.object(frappe, "get_doc", return_value=self.row),
			patch.object(api, "duty_doc", return_value=self.doc),
			patch.object(api, "activity_doc", return_value=(self.row, self.doc)),
			patch.object(frappe, "db", Mock(exists=Mock(return_value=True))),
			patch.object(
				frappe, "throw", side_effect=frappe.ValidationError("Wait for the shop photo location")
			),
			patch.object(api, "location") as gps,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Wait for the shop photo location"):
				api.complete_activity("visit", {})
			gps.assert_not_called()
