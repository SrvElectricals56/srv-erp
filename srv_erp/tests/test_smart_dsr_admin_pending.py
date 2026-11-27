"""Isolated administrator duty-resolution regressions; no live database writes."""

import base64
import hashlib
import io
import types
import unittest
from contextlib import ExitStack
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe
from PIL import Image

from srv_erp.smart_dsr import admin
from srv_erp.smart_dsr import admin_duty_resolution as resolution


class Row(frappe._dict):
	def set(self, key, value):
		self[key] = value

	def as_dict(self):
		return dict(self)


class TestAdminPendingDuty(unittest.TestCase):
	def setUp(self):
		self.stack = ExitStack()
		self.addCleanup(self.stack.close)
		self.now = datetime(2026, 11, 20, 18)
		self.start = self.now - timedelta(hours=6)
		self.duty = Row(
			doctype="DSR Duty Session",
			name="duty-1",
			account="sales@test",
			status="Active",
			started_at=self.start,
			ended_at=None,
		)
		self.visit = Row(
			doctype="DSR Dealer Activity",
			name="visit-1",
			duty="duty-1",
			account="sales@test",
			status="Open",
			customer="dealer-1",
			arrived_at=self.start,
			remarks="Original note",
			photo_exception=None,
			reward_points=0,
		)
		self.rows = {("DSR Dealer Activity", "visit-1"): self.visit}

		def throw(message, error=None):
			raise (error or frappe.ValidationError)(message)

		self.fake = types.SimpleNamespace(
			throw=throw,
			PermissionError=frappe.PermissionError,
			DoesNotExistError=frappe.DoesNotExistError,
			get_doc=lambda dt, name, **kw: self.rows[(dt, name)],
			get_all=Mock(return_value=[]),
			db=types.SimpleNamespace(get_value=Mock(return_value="Dealer One")),
		)
		self.audit, self.save = Mock(), Mock()
		self.expense = Mock(return_value={"name": "expense-1"})
		self.inserted = []
		self.stored_digest = hashlib.sha256(b"stored photo bytes").hexdigest()

		def insert(dt, **values):
			row = Row(doctype=dt, name="evidence-1", **values)
			self.inserted.append(row)
			return row

		for obj, key, replacement in [
			(resolution, "frappe", self.fake),
			(resolution, "now_datetime", Mock(return_value=self.now)),
			(resolution.api, "valid_photo", Mock(return_value=False)),
			(resolution.api, "save", self.save),
			(resolution.admin, "audit", self.audit),
			(resolution.api, "settings", Mock(return_value=Row(max_accuracy_m=50))),
			(resolution.api, "record_expense_document", self.expense),
			(
				resolution,
				"attach_photo",
				Mock(return_value=Row(name="file-1", file_url="/private/files/admin.png")),
			),
			(resolution, "saved_photo_sha256", Mock(return_value=self.stored_digest)),
			(resolution.api, "insert", Mock(side_effect=insert)),
		]:
			self.stack.enter_context(patch.object(obj, key, replacement))
		self.stack.enter_context(patch("frappe.utils.get_system_timezone", return_value="Asia/Kolkata"))

	def stamp(self, hours=0):
		return (self.now - timedelta(hours=hours)).isoformat() + "+05:30"

	def item(self, **extra):
		return {
			"name": "visit-1",
			"departed_at": self.stamp(1),
			"completion_note": "Dealer confirms visit and collection.",
			**extra,
		}

	def image(self):
		out = io.BytesIO()
		Image.new("RGB", (100, 100), "white").save(out, "PNG")
		return out.getvalue()

	def test_requirements_list_all_named_blockers(self):
		self.duty.odometer_required = 1
		self.fake.get_all.side_effect = (
			lambda dt, **kw: [self.visit]
			if dt == "DSR Dealer Activity"
			else [Row(name="break-1", break_type="Lunch", started_at=self.start)]
			if dt == "DSR Break"
			else [Row(name="stay-1", checked_in_at=self.start, address="Hotel")]
		)
		with patch.object(resolution, "meter_photo_valid", side_effect=lambda doc, phase: phase == "start"):
			r = resolution.requirements(self.duty, "Closed")
		self.assertEqual(r["visits"][0]["customer_name"], "Dealer One")
		self.assertTrue(r["visits"][0]["photo_missing"])
		self.assertEqual(r["breaks"][0]["name"], "break-1")
		self.assertEqual(r["stays"][0]["name"], "stay-1")
		self.assertEqual([v["phase"] for v in r["odometer"]], ["end"])

	def test_missing_fields_rejected_and_exception_completion_preserves_gps_rewards(self):
		for item in [self.item(), self.item(completion_note="", photo_exception="Camera failed")]:
			with self.assertRaises(frappe.ValidationError):
				resolution.apply(self.duty, {"visits": [item]}, "test")
		self.save.assert_not_called()
		resolution.apply(
			self.duty, {"visits": [self.item(photo_exception="Dealer verified visit; camera failed")]}, "test"
		)
		self.assertEqual(self.visit.status, "Completed")
		self.assertEqual(self.visit.activity_duration_minutes, 300)
		self.assertIn("Original note", self.visit.remarks)
		self.assertIn("Administrator approved", self.visit.photo_exception)
		self.assertIsNone(self.visit.departure_latitude)
		self.assertEqual(self.visit.reward_points, 0)
		self.assertEqual(self.audit.call_args.args[2]["status"], "Open")
		self.assertEqual(self.audit.call_args.args[3]["status"], "Completed")

	def test_uploaded_supporting_photo_has_admin_source_and_verified_hash(self):
		content = self.image()
		photo = {"content": base64.b64encode(content).decode(), "reported_at": self.stamp(2)}
		resolution.apply(self.duty, {"visits": [self.item(photo=photo)]}, "test")
		self.assertEqual(self.inserted[0].sha256, self.stored_digest)
		resolution.saved_photo_sha256.assert_called_once_with("file-1")
		self.assertIn("Administrator supplied", self.inserted[0].capture_source)
		self.assertEqual(self.visit.status, "Completed")

	def test_cross_duty_times_and_resolved_records_rejected(self):
		self.visit.duty = "other"
		with self.assertRaises(frappe.PermissionError):
			resolution.apply(self.duty, {"visits": [self.item(photo_exception="Camera failed")]}, "test")
		self.visit.duty = "duty-1"
		for stamp in [self.stamp(-1), self.stamp(7)]:
			with self.assertRaises(frappe.ValidationError):
				resolution.apply(
					self.duty,
					{"visits": [self.item(departed_at=stamp, photo_exception="Camera failed")]},
					"test",
				)
		self.assertEqual(self.visit.status, "Open")
		self.visit.status = "Completed"
		with patch.object(resolution.api, "valid_photo", return_value=True):
			with self.assertRaises(frappe.ValidationError):
				resolution.apply(self.duty, {"visits": [self.item()]}, "test")

	def test_break_and_night_checkout_keep_duration_and_geofence_rules(self):
		row = Row(
			doctype="DSR Break",
			name="break-1",
			duty="duty-1",
			account="sales@test",
			started_at=self.now - timedelta(hours=2),
			ended_at=None,
			duration_minutes=0,
		)
		self.rows[(row.doctype, row.name)] = row
		resolution.apply(self.duty, {"breaks": [{"name": row.name, "ended_at": self.stamp(1)}]}, "test")
		self.assertEqual(row.duration_minutes, 60)
		stay = Row(
			doctype="DSR Night Stay",
			name="stay-1",
			duty="duty-1",
			account="sales@test",
			checked_in_at=self.start,
			checked_out_at=None,
			latitude=29.99,
			longitude=75.39,
			accuracy=5,
			expense=None,
		)
		self.rows[(stay.doctype, stay.name)] = stay
		item = {
			"name": stay.name,
			"checked_out_at": self.stamp(1),
			"gps": {"latitude": 29.99, "longitude": 75.39, "accuracy": 5},
		}
		for bad in [
			dict(item, checked_out_at=self.stamp(5)),
			dict(item, gps={"latitude": 31, "longitude": 77, "accuracy": 5}),
		]:
			with self.assertRaises(frappe.ValidationError):
				resolution.apply(self.duty, {"stays": [bad]}, "test")
		self.expense.assert_not_called()
		resolution.apply(self.duty, {"stays": [item]}, "test")
		self.assertEqual(stay.duration_minutes, 300)
		self.assertEqual(stay.expense, "expense-1")
		self.assertEqual(self.expense.call_args.args[2], 1200)

	def test_meter_upload_does_not_replace_existing_verified_photo(self):
		self.duty.odometer_required = 1
		content = self.image()
		item = {
			"phase": "end",
			"reading": "2500",
			"reported_at": self.stamp(1),
			"photo": {"content": base64.b64encode(content).decode()},
		}
		with patch.object(resolution, "meter_photo_valid", return_value=False):
			resolution.apply(self.duty, {"odometer": [item]}, "test")
		self.assertEqual(self.duty.odometer_end, 2500)
		self.assertEqual(self.duty.odometer_end_sha256, self.stored_digest)
		resolution.saved_photo_sha256.assert_called_once_with("file-1")
		with patch.object(resolution, "meter_photo_valid", return_value=True):
			with self.assertRaises(frappe.ValidationError):
				resolution.apply(self.duty, {"odometer": [item]}, "test")

	def test_invalid_inputs_and_unauthorized_requirement_access_rejected(self):
		with self.assertRaises(frappe.ValidationError):
			resolution.photo_bytes({"content": base64.b64encode(b"not image").decode()})
		with self.assertRaises(frappe.ValidationError):
			resolution.apply(self.duty, {"accounts": []}, "test")
		with self.assertRaises(frappe.ValidationError):
			resolution.apply(self.duty, {"visits": [self.item(photo_exception="Camera failed")] * 2}, "test")
		with patch.object(admin, "require_admin", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				admin.duty_status_requirements.__wrapped__("duty-1", "Closed")

	def test_status_change_resolves_pending_visit_before_closing_duty(self):
		def exists(doctype, filters):
			return doctype == "DSR Dealer Activity" and self.visit.status == "Open"

		api_frappe = types.SimpleNamespace(
			throw=self.fake.throw,
			db=types.SimpleNamespace(exists=exists),
			get_all=lambda *args, **kwargs: [self.visit] if self.visit.status == "Completed" else [],
		)
		with ExitStack() as stack:
			for obj, key, replacement in [
				(admin, "frappe", api_frappe),
				(admin, "require_admin", Mock()),
				(admin, "locked_record", Mock(return_value=self.duty)),
				(admin, "prior", Mock(return_value=None)),
				(admin, "now_datetime", Mock(return_value=self.now)),
				(admin, "response_audit", lambda value: {"audit": "success"}),
				(admin.api, "recalculate", Mock()),
				(admin.api, "event", Mock()),
			]:
				stack.enter_context(patch.object(obj, key, replacement))
			stack.enter_context(patch("srv_erp.smart_dsr.meal_expenses.post_due_meals"))
			result = admin.change_duty_status.__wrapped__(
				"duty-1",
				"Closed",
				"status-request",
				resolutions={"visits": [self.item(photo_exception="Dealer confirmed; camera failed")]},
			)
		self.assertEqual(result["audit"], "success")
		self.assertEqual(self.visit.status, "Completed")
		self.assertEqual(self.duty.status, "Closed")
		self.assertEqual(self.duty.ended_at, self.now)
		self.assertGreaterEqual(self.audit.call_count, 2)
