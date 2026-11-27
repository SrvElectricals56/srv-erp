"""Website integration checks, using rollback-only fixtures from the existing suite."""

import base64
import io
import json
import unittest
from pathlib import Path

import frappe

from srv_erp.smart_dsr import api
from srv_erp.tests import test_smart_dsr as fixtures


class TestWebsite(unittest.TestCase):
	setUp = fixtures.TestSmartDSR.setUp
	cleanup = fixtures.TestSmartDSR.cleanup
	start = fixtures.TestSmartDSR.start

	def arrive(self, request="arrival-website"):
		return api.dealer_arrival(self.start(), self.customer.name, self.gps, request)

	def finish(self, activity):
		frappe.set_user("Administrator")
		api.authorize_exception(
			frappe.db.get_value("DSR Dealer Activity", activity, "duty"), "Test approved exception", activity
		)
		frappe.set_user(self.user)
		return api.complete_activity(activity, self.gps)

	def test_each_document_required_and_recorded(self):
		for missing in ("insurance", "puc", "rc", "fastag"):
			values = dict(insurance=True, puc=True, rc=True, fastag=True)
			values[missing] = False
			with self.assertRaises(frappe.ValidationError):
				api.duty_on("TEST", "CNG", "Home", self.gps, "test-missing", documents=values)
		with self.assertRaises(frappe.ValidationError):
			api.duty_on("TEST", "CNG", "Home", self.gps, "test-missing")
		doc = api.summary(self.start())["duty"]
		for field in ("insurance", "puc", "rc", "fastag"):
			self.assertEqual(doc["confirmed_" + field], 1)
		self.assertEqual(doc["documents_confirmed_by"], self.user)
		self.assertTrue(doc["documents_confirmed_at"])

	def test_sequential_visits_details_review_and_idempotent_submit(self):
		first = self.arrive()
		api.save_visit_review(first, dict(product="Good quality", complaints="None"))
		self.finish(first)
		self.assertEqual(api.complete_activity(first, self.gps), first)
		with self.assertRaises(frappe.PermissionError):
			api.save_visit_review(first, dict(product="Changed"))
		second = api.dealer_arrival(self.start(), self.customer.name, self.gps, "arrival-second")
		details = api.visit_details(second)
		self.assertEqual(details["visit"]["visit_number"], 2)
		self.assertEqual(details["visit"]["origin_activity"], first)
		self.assertIn("Unverified", details["visit"]["travel_verification"])
		self.assertGreaterEqual(details["visit"]["travel_duration_seconds"], 0)
		self.assertEqual(details["visit"]["travel_distance_km"], 0)
		self.assertEqual(api.summary(self.start())["duty"]["status"], "Active")
		self.assertEqual(len(api.previous_reviews(self.customer.name)), 1)
		self.finish(second)
		self.assertEqual(len(api.summary(self.start())["activities"]), 2)

	def test_visit_collection_link_and_cash(self):
		activity = self.arrive()
		result = api.visit_collection(activity, 100, "Cash", "visit-cash-key")
		self.assertEqual(result["balance"], 1100)
		self.assertEqual(
			api.visit_collection(activity, 100, "Cash", "visit-cash-key")["name"], result["name"]
		)
		self.assertEqual(len(api.visit_details(activity)["collections"]), 1)
		self.assertEqual(result["accounting_status"], "Recorded")

	def test_duty_and_visit_camera_photos_survive_frappe_jpeg_reencoding(self):
		from unittest.mock import patch

		from frappe.utils.file_manager import save_file
		from PIL import Image

		def camera_photo(color):
			image = io.BytesIO()
			exif = Image.Exif()
			exif[274] = 6  # EXIF orientation
			Image.new("RGB", (120, 120), color).save(image, format="JPEG", exif=exif)
			return image.getvalue()

		def saved_photo(url):
			self.assertTrue(url.startswith("/private/files/"))
			path = Path(frappe.get_site_path("private", "files", url.rsplit("/", 1)[1]))
			self.addCleanup(lambda: path.unlink(missing_ok=True))
			return path.read_bytes()

		get_system_settings = frappe.get_system_settings

		def system_settings(strip_exif):
			def setting(key):
				return (
					strip_exif
					if key == "strip_exif_metadata_from_uploaded_images"
					else get_system_settings(key)
				)

			return setting

		meter = camera_photo("gray")
		shop = camera_photo("white")
		# Identical bytes in another account's private files must never be reused.
		frappe.set_user("Administrator")
		with patch.object(frappe, "get_system_settings", side_effect=system_settings(False)):
			private_meter = save_file("other-account-meter.jpg", meter, None, None, is_private=1)
			private_shop = save_file("other-account-shop.jpg", shop, None, None, is_private=1)
		self.assertEqual(saved_photo(private_meter.file_url), meter)
		self.assertEqual(saved_photo(private_shop.file_url), shop)
		frappe.set_user(self.user)
		vehicle, request_key = "PB31AB1234", "start-duty-key"
		meter_challenge = api.odometer_camera_challenge(
			"start", 100, vehicle_number=vehicle, request_key=request_key
		)
		with patch.object(frappe, "get_system_settings", side_effect=system_settings(True)):
			duty = api.duty_on(
				vehicle_number=vehicle,
				gps=self.gps,
				request_key=request_key,
				odometer_start=100,
				odometer_photo={"challenge": meter_challenge, "content": base64.b64encode(meter).decode()},
			)["duty"]["name"]
		meter_url = frappe.db.get_value("DSR Duty Session", duty, "odometer_start_photo")
		self.assertNotEqual(meter_url, private_meter.file_url)
		self.assertNotEqual(saved_photo(meter_url), meter)
		activity = api.dealer_arrival(duty, self.customer.name, self.gps, "arrival-website")
		challenge = api.browser_photo_challenge(activity)
		with self.assertRaises(frappe.ValidationError):
			api.browser_photo(activity, challenge, "not-an-image", self.gps)
		image = base64.b64encode(shop).decode()
		with patch.object(frappe, "get_system_settings", side_effect=system_settings(True)):
			result = api.browser_photo(activity, challenge, image, self.gps)
		self.assertNotEqual(result["photo"], private_shop.file_url)
		self.assertNotEqual(saved_photo(result["photo"]), shop)
		self.assertTrue(api.valid_photo(activity, self.user))
		self.assertTrue(api.visit_details(activity)["photo_verified"])
		self.assertEqual(api.order_return_reference(activity)["customer"], self.customer.name)
		with self.assertRaises(frappe.ValidationError):
			api.browser_photo(activity, challenge, image, self.gps)
		api.complete_activity(activity, self.gps)

		ending_meter = camera_photo("blue")
		ending_challenge = api.odometer_camera_challenge("end", 225, duty=duty)
		with patch.object(frappe, "get_system_settings", side_effect=system_settings(True)):
			closed = api.duty_off(
				duty,
				self.gps,
				odometer_end=225,
				odometer_photo={
					"challenge": ending_challenge,
					"content": base64.b64encode(ending_meter).decode(),
				},
			)["duty"]
		self.assertEqual(closed["status"], "Closed")
		self.assertEqual(closed["odometer_distance"], 125)
		self.assertNotEqual(saved_photo(closed["odometer_end_photo"]), ending_meter)
		self.assertEqual(api.finalize(duty)["duty"]["status"], "Finalized")

	def test_delete_photo_then_retake_before_submit(self):
		from PIL import Image

		activity = self.arrive("delete-retake-visit")

		def capture(color):
			image = io.BytesIO()
			Image.new("RGB", (120, 120), color).save(image, format="JPEG")
			challenge = api.browser_photo_challenge(activity)
			photo = api.browser_photo(
				activity, challenge, base64.b64encode(image.getvalue()).decode(), self.gps
			)
			path = Path(frappe.get_site_path("private", "files", photo["photo"].rsplit("/", 1)[1]))
			self.addCleanup(lambda: path.unlink(missing_ok=True))
			return photo

		first = capture("red")
		self.assertTrue(api.valid_photo(activity, self.user))
		api.retake_visit_photo(activity)
		self.assertFalse(api.valid_photo(activity, self.user))
		self.assertFalse(api.visit_details(activity)["photos"])
		self.assertFalse(frappe.db.exists("File", {"file_url": first["photo"]}))
		self.assertTrue(frappe.db.exists("DSR Dealer Photo Evidence", first["name"]))
		with self.assertRaises(frappe.ValidationError):
			api.complete_activity(activity, self.gps)
		second = capture("blue")
		self.assertTrue(api.valid_photo(activity, self.user))
		self.assertEqual(api.visit_details(activity)["photos"][0]["name"], second["name"])
		api.complete_activity(activity, self.gps)
		with self.assertRaises(frappe.PermissionError):
			api.retake_visit_photo(activity)

	def test_order_reference_cannot_link_unsubmitted_or_other_user(self):
		activity = self.arrive()
		ref = api.order_return_reference(activity)
		self.assertEqual(ref["customer"], self.customer.name)
		with self.assertRaises(frappe.PermissionError):
			api.link_visit_order("invalid", "invalid")
		frappe.set_user("Administrator")
		with self.assertRaises(frappe.PermissionError):
			api.link_visit_order(ref["token"], "invalid")

	def test_end_workday_requires_completed_visits(self):
		activity = self.arrive()
		with self.assertRaises(frappe.ValidationError):
			api.end_workday(self.start(), self.gps)
		self.finish(activity)
		result = api.end_workday(self.start(), self.gps)
		self.assertEqual(result["duty"]["status"], "Finalized")
		self.assertEqual(result["available_cash"], 1000)

	def test_order_visit_field_cannot_be_forged(self):
		from unittest.mock import Mock

		doc = Mock()
		doc.get_doc_before_save.return_value = None
		doc.get.return_value = "forged-visit"
		with self.assertRaises(frappe.PermissionError):
			api.protect_order_visit(doc)

	def test_verified_travel_uses_samples_and_elapsed_interval(self):
		from datetime import timedelta
		from unittest.mock import patch

		from frappe.utils import get_datetime

		name = self.start()
		start = api.capture_time(api.summary(name)["duty"]["started_at"])
		arrival = start + timedelta(seconds=30)
		with patch.object(api, "now_datetime", return_value=arrival):
			api.gps_batch(
				name,
				[
					dict(
						self.gps,
						latitude=28.001,
						id="travel-middle",
						captured_at=str(start + timedelta(seconds=15)),
					),
					dict(self.gps, latitude=28.002, id="travel-arrival", captured_at=str(arrival)),
				],
			)
			activity = api.dealer_arrival(
				name, self.customer.name, dict(self.gps, latitude=28.002), "travel-visit"
			)
		row = api.visit_details(activity)["visit"]
		self.assertEqual(row["travel_verification"], "Verified GPS samples")
		self.assertAlmostEqual(row["travel_duration_seconds"], 30, places=2)
		self.assertGreater(row["travel_distance_km"], 0.2)

	def test_submitted_order_links_to_same_visit(self):
		from unittest.mock import Mock, patch

		activity = self.arrive()
		ref = api.order_return_reference(activity)
		order = Mock(
			docstatus=1,
			customer=self.customer.name,
			company=api.settings().company,
			owner=self.user,
			custom_dsr_visit=None,
		)
		get_doc = frappe.get_doc

		def load(doctype, *args, **kwargs):
			return order if doctype == "Sales Order" else get_doc(doctype, *args, **kwargs)

		with patch.object(frappe, "get_doc", side_effect=load):
			self.assertEqual(api.link_visit_order(ref["token"], "test-order"), activity)
			order.db_set.assert_called_once_with("custom_dsr_visit", activity, update_modified=False)
			order.docstatus = 0
			with self.assertRaises(frappe.ValidationError):
				api.link_visit_order(ref["token"], "test-order")
