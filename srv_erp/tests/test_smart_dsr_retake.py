"""Retake metadata and remarks-only review regressions without database writes."""

import base64
import io
import json
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe
from PIL import Image

from srv_erp.smart_dsr import api


class TestVisitRetake(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)

	def test_retake_removes_all_current_images_before_new_challenge(self):
		with (
			patch.object(
				api, "activity_doc", return_value=(frappe._dict(name="visit"), frappe._dict(account="user"))
			),
			patch.object(frappe, "get_all", return_value=["old-one", "old-two"]),
			patch.object(api, "_remove_visit_photo") as remove,
			patch.object(api, "browser_photo_challenge", return_value="new-challenge"),
		):
			self.assertEqual(api.retake_visit_photo("visit"), "new-challenge")
			self.assertEqual(
				[call.args for call in remove.call_args_list], [("visit", "old-one"), ("visit", "old-two")]
			)
		self.assertFalse(hasattr(api, "delete_visit_photo"))

	def test_replacement_photo_updates_visit_time_and_location(self):
		for replacing in (False, True):
			with self.subTest(replacing=replacing):
				row = frappe._dict(
					name="visit", arrived_at=datetime(2026, 11, 16, 9), latitude=28, longitude=77, accuracy=5
				)
				doc = frappe._dict(name="duty", account="user")
				stamp = datetime(2026, 11, 16, 10)
				point = dict(latitude=28.5, longitude=77.5, accuracy=10)
				cache = Mock()
				cache.get_value.return_value = dict(activity="visit", account="user")
				db = Mock()
				db.exists.return_value = replacing
				image = io.BytesIO()
				Image.new("RGB", (120, 120), "blue").save(image, format="JPEG")
				with (
					patch.object(api, "activity_doc", return_value=(row, doc)),
					patch.object(frappe, "cache", return_value=cache),
					patch.object(frappe, "db", db),
					patch.object(frappe, "flags", frappe._dict()),
					patch.object(api, "location", return_value=point),
					patch.object(api, "now_datetime", return_value=stamp),
					patch("frappe.utils.get_system_timezone", return_value="Asia/Kolkata"),
					patch.object(
						api,
						"insert",
						side_effect=lambda dt, **values: frappe._dict(doctype=dt, name="new-photo", **values),
					),
					patch(
						"frappe.utils.file_manager.save_file",
						return_value=frappe._dict(file_url="/private/files/new.jpg"),
					),
					patch.object(api, "save"),
					patch.object(api, "prepare_visit_travel") as travel,
					patch.object(api, "event") as audit,
				):
					result = api.browser_photo(
						"visit", "challenge", base64.b64encode(image.getvalue()).decode(), point
					)
					self.assertEqual(result["photo"], "/private/files/new.jpg")
					self.assertEqual(row.arrived_at, stamp)
					self.assertEqual((row.latitude, row.longitude, row.accuracy), (28.5, 77.5, 10))
					travel.assert_called_once_with(row, doc)
					if replacing:
						audit.assert_called_once()
					else:
						audit.assert_not_called()
					cache.delete_value.assert_called_once_with("dsr-web-photo:challenge")

	def test_review_saves_only_remarks(self):
		row = frappe._dict(name="visit")
		with (
			patch.object(api, "activity_doc", return_value=(row, frappe._dict(account="user"))),
			patch.object(api, "valid_photo", return_value=True),
			patch.object(api, "save"),
		):
			api.save_visit_review("visit", dict(remarks="Visited dealer", product="Old field"))
			self.assertEqual(json.loads(row.dealer_review), {"remarks": "Visited dealer"})
