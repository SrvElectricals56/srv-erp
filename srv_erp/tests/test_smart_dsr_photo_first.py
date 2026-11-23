"""Photo-first visit lifecycle without database writes."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api


class TestPhotoFirstVisit(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)

	def test_dealer_selection_does_not_require_location(self):
		doc = frappe._dict(name="duty", account="user", started_at="2026-11-18 09:00:00")
		row = frappe._dict(name="visit")
		with (
			patch.object(api, "active", return_value=doc),
			patch.object(api, "repeated", return_value=None),
			patch.object(api, "locked_exists", return_value=False),
			patch.object(api, "outstanding", return_value={"pending": 0, "overdue": 0}),
			patch.object(frappe, "get_all", return_value=[]),
			patch.object(frappe, "db", Mock(sql=Mock(return_value=[(0, 0)]))),
			patch.object(api, "location") as gps,
			patch.object(api, "key", return_value="request"),
			patch.object(api, "now_datetime", return_value="2026-11-18 10:00:00"),
			patch.object(api, "insert", return_value=row) as insert,
			patch.object(api, "prepare_visit_travel"),
		):
			self.assertEqual(api.dealer_arrival("duty", "dealer", request_key="request"), "visit")
			gps.assert_not_called()
			self.assertNotIn("latitude", insert.call_args.kwargs)
			self.assertNotIn("longitude", insert.call_args.kwargs)

	def test_visit_services_require_existing_valid_photo(self):
		row, doc = frappe._dict(name="visit"), frappe._dict(account="user")
		for method, args in (
			(api.save_visit_review, ("visit", {"remarks": "Test"})),
			(api.visit_collection, ("visit", 100, "Cash", "request")),
			(api.order_return_reference, ("visit",)),
		):
			with (
				self.subTest(method=method.__name__),
				patch.object(api, "activity_doc", return_value=(row, doc)),
				patch.object(api, "valid_photo", return_value=False) as photo,
				patch.object(frappe, "throw", side_effect=frappe.ValidationError("Upload a live shop photo")),
			):
				with self.assertRaisesRegex(frappe.ValidationError, "Upload a live shop photo"):
					method(*args)
				photo.assert_called_once_with("visit", "user")

	def test_valid_photo_allows_services(self):
		with patch.object(api, "valid_photo", return_value=True), patch.object(frappe, "throw") as reject:
			api.require_visit_photo(frappe._dict(name="visit"), "user")
			reject.assert_not_called()
