"""Odometer reading, camera binding, evidence, and Duty OFF regressions."""

import base64
import hashlib
import io
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe
from PIL import Image

from srv_erp.smart_dsr import api, odometer, security


class TestOdometer(unittest.TestCase):
	def setUp(self):
		for mock in (
			patch("srv_erp.smart_dsr.night_stay.duty_off_wait", return_value={"remaining_seconds": 0}),
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(frappe, "throw", side_effect=self.throw),
		):
			mock.start()
			self.addCleanup(mock.stop)
		image = io.BytesIO()
		Image.new("RGB", (120, 120), "white").save(image, format="JPEG")
		self.image = image.getvalue()

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_readings_and_difference(self):
		self.assertEqual(odometer.reading(0), 0)
		self.assertEqual(odometer.difference("1000.10", "1123.55"), 123.45)
		self.assertEqual(odometer.difference(1000, 1000), 0)
		for value in (None, "", True, -1, "NaN", "Infinity", "not a reading"):
			with self.subTest(value=value), self.assertRaises(frappe.ValidationError):
				odometer.reading(value)
		with self.assertRaises(frappe.ValidationError):
			odometer.difference(1000, 999.99)

	def test_camera_photo_is_bound_to_reading_owner_vehicle_and_action(self):
		expected = odometer.context("start", "user", 1000, "PB31AB1234", "request-key")
		cache = Mock()
		cache.get_value.return_value = expected
		payload = {"challenge": "token", "content": base64.b64encode(self.image).decode()}
		with (
			patch.object(frappe, "cache", return_value=cache),
			patch.object(odometer, "now_datetime", return_value=datetime(2026, 11, 16, 7)),
		):
			photo = odometer.validate_photo(payload, expected)
			self.assertEqual(photo["sha256"], hashlib.sha256(self.image).hexdigest())
			for field, changed in (
				("phase", "end"),
				("account", "other"),
				("reading", 2000),
				("vehicle", "DL1CAA1234"),
				("request_key", "other-request"),
			):
				with self.subTest(field=field), self.assertRaises(frappe.ValidationError):
					odometer.validate_photo(payload, {**expected, field: changed})
			cache.get_value.return_value = None
			with self.assertRaises(frappe.ValidationError):
				odometer.validate_photo(payload, expected)

	def test_non_camera_files_and_pdf_are_rejected(self):
		expected = odometer.context("start", "user", 1000, "PB31AB1234", "request-key")
		cache = Mock()
		cache.get_value.return_value = expected
		with patch.object(frappe, "cache", return_value=cache):
			for payload in (
				None,
				{"file_url": "/private/files/old.jpg"},
				{"challenge": "token", "content": base64.b64encode(b"%PDF-1.4").decode()},
			):
				with self.subTest(payload=payload), self.assertRaises(frappe.ValidationError):
					odometer.validate_photo(payload, expected)

	def test_ending_reading_and_photo_required_for_new_duty(self):
		doc = frappe._dict(
			name="duty",
			account="user",
			vehicle_number="PB31AB1234",
			status="Active",
			odometer_required=1,
			odometer_start=1000,
			odometer_start_photo="/private/files/start.jpg",
			gps_exception="Authorized GPS exception",
		)
		with (
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(
				api,
				"locked_exists",
				side_effect=lambda dt, filters: dt == "DSR Dealer Activity"
				and filters.get("status") == "Completed",
			),
			patch.object(odometer, "validate_stored_photo"),
			patch.object(odometer, "attach_photo") as attach,
			patch.object(api, "save") as save,
		):
			for end, photo in ((None, None), (999, {"challenge": "token"}), (1100, None)):
				with self.subTest(end=end), self.assertRaises(frappe.ValidationError):
					api.duty_off("duty", None, odometer_end=end, odometer_photo=photo)
			attach.assert_not_called()
			save.assert_not_called()

	def test_duty_off_records_difference_without_changing_gps_distance(self):
		doc = frappe._dict(
			name="duty",
			account="user",
			vehicle_number="PB31AB1234",
			status="Active",
			odometer_required=1,
			odometer_start=1000,
			odometer_start_photo="/private/files/start.jpg",
			gps_exception="Authorized GPS exception",
			verified_km=5,
		)
		proof = {"data": self.image}
		with (
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(
				api,
				"locked_exists",
				side_effect=lambda dt, filters: dt == "DSR Dealer Activity"
				and filters.get("status") == "Completed",
			),
			patch.object(odometer, "validate_stored_photo"),
			patch.object(odometer, "validate_photo", return_value=proof) as validate,
			patch.object(odometer, "attach_photo") as attach,
			patch("srv_erp.smart_dsr.meal_expenses.post_due_meals"),
			patch.object(api, "recalculate"),
			patch.object(api, "save"),
			patch.object(api, "event"),
			patch.object(api, "now_datetime", return_value=datetime(2026, 11, 16, 18)),
			patch.object(api, "summary", return_value={}),
		):
			api.duty_off("duty", None, odometer_end=1123.45, odometer_photo={"challenge": "token"})
			self.assertEqual(doc.odometer_distance, 123.45)
			self.assertEqual(doc.verified_km, 5)
			self.assertEqual(doc.status, "Closed")
			attach.assert_called_once_with(doc, "end", proof)
			self.assertEqual(
				validate.call_args.args[1],
				odometer.context("end", "user", 1123.45, "PB31AB1234", duty="duty"),
			)

	def test_changed_stored_photo_is_rejected(self):
		doc = frappe._dict(
			name="duty",
			doctype="DSR Duty Session",
			odometer_start_photo="/private/files/start.jpg",
			odometer_start_sha256=hashlib.sha256(self.image).hexdigest(),
		)
		with (
			patch.object(frappe, "db", Mock()),
			patch.object(
				frappe, "get_doc", return_value=Mock(get_content=Mock(return_value=b"changed photo"))
			),
		):
			frappe.db.get_value.return_value = "file"
			with self.assertRaises(frappe.ValidationError):
				odometer.validate_stored_photo(doc, "start")

	def test_odometer_attachment_cannot_be_deleted_or_detached_directly(self):
		previous = frappe._dict(
			attached_to_doctype="DSR Duty Session", attached_to_field="odometer_start_photo"
		)
		doc = Mock(attached_to_doctype="DSR Expense Record", attached_to_field="receipt")
		doc.get_doc_before_save.return_value = previous
		with patch.object(frappe, "flags", frappe._dict()):
			with self.assertRaises(frappe.PermissionError):
				security.protect_evidence_file(doc)
