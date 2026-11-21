"""Duty OFF preflight reports the same unfinished work that prevents closing."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api


class TestDutyReadiness(unittest.TestCase):
	def setUp(self):
		self.doc = frappe._dict(name="duty", account="user", status="Active")
		for mock in (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(api, "duty_doc", return_value=self.doc),
			patch.object(frappe, "db", Mock(exists=Mock(return_value=False))),
		):
			mock.start()
			self.addCleanup(mock.stop)

	def test_pending_visits_and_active_breaks_prevent_duty_off(self):
		for visits, breaks in ((True, False), (False, True), (True, True)):

			def rows(dt, **kwargs):
				if dt == "DSR Dealer Activity":
					return [frappe._dict(name="visit", customer="Dealer")] if visits else []
				if dt == "DSR Break":
					return [frappe._dict(name="break", break_type="Lunch")] if breaks else []
				return []

			with (
				self.subTest(visits=visits, breaks=breaks),
				patch.object(frappe, "get_all", side_effect=rows),
				patch.object(api, "valid_photo") as photo,
			):
				result = api.duty_off_readiness("duty")
				self.assertFalse(result["ready"])
				self.assertEqual(len(result["tasks"]), int(visits) + int(breaks))
				self.assertIn("before Duty OFF", result["message"])
				photo.assert_not_called()

	def test_missing_completed_visit_evidence_prevents_closing(self):
		def rows(dt, **kwargs):
			return (
				[frappe._dict(name="visit", photo_exception=None)]
				if kwargs["filters"].get("status") == "Completed"
				else []
			)

		with (
			patch.object(frappe, "get_all", side_effect=rows),
			patch.object(api, "valid_photo", return_value=False),
		):
			result = api.duty_off_readiness("duty")
			self.assertFalse(result["ready"])
			self.assertEqual(result["tasks"], [{"type": "evidence", "name": "visit"}])

	def test_completed_work_and_authorized_photo_exception_are_ready(self):
		def rows(dt, **kwargs):
			return (
				[frappe._dict(name="visit", photo_exception="Authorized")]
				if kwargs["filters"].get("status") == "Completed"
				else []
			)

		with patch.object(frappe, "get_all", side_effect=rows), patch.object(api, "valid_photo") as photo:
			self.assertTrue(api.duty_off_readiness("duty")["ready"])
			photo.assert_not_called()

	def test_ended_duty_returns_to_workday_without_new_work(self):
		self.doc.status = "Finalized"
		with patch.object(frappe, "get_all") as query:
			self.assertFalse(api.duty_off_readiness("duty")["ready"])
			query.assert_not_called()
