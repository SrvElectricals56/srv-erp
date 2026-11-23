"""Approximate browser fixes are recorded, never upgraded to verified distance."""

import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api
from srv_erp.smart_dsr.policy import segment


class TestGPSAccuracy(unittest.TestCase):
	def setUp(self):
		def throw(message, *args, **kwargs):
			raise frappe.ValidationError(message)

		stub = patch.object(frappe, "throw", side_effect=throw)
		stub.start()
		self.addCleanup(stub.stop)

	def test_browser_fix_keeps_original_accuracy(self):
		point = api.location(dict(latitude=29.99, longitude=75.39, accuracy=5000))
		self.assertEqual(point["accuracy"], 5000)

	def test_invalid_location_still_rejected(self):
		for point in (
			None,
			dict(latitude=91, longitude=75, accuracy=10),
			dict(latitude=29, longitude=75, accuracy=-1),
		):
			with self.assertRaises(frappe.ValidationError):
				api.location(point)

	def test_coarse_fix_never_earns_distance(self):
		previous = dict(latitude=29.99, longitude=75.39, accuracy=5)
		current = dict(latitude=30.0, longitude=75.4, accuracy=5000)
		self.assertEqual(segment(previous, current, 60), (0, "Poor accuracy"))

	def test_enrolled_photo_precision_policy_is_retained(self):
		with patch.object(api, "settings", return_value=frappe._dict(max_accuracy_m=50)):
			with self.assertRaises(frappe.ValidationError):
				api.location(dict(latitude=29.99, longitude=75.39, accuracy=5000), require_precise=True)

	def test_recovery_batch_orders_offsets_and_counts_after_first_fresh_fix(self):
		start = datetime(2026, 11, 23, 6, 55)
		now = start.replace(minute=56)
		duty = frappe._dict(
			name="duty",
			account="sales@example.invalid",
			status="Active",
			started_at=start,
			gps_status="Interrupted",
			gps_interrupted_at=start.replace(second=15),
			last_point="initial",
			flags=frappe._dict(),
			reload=Mock(),
		)
		initial = dict(latitude=28, longitude=77, accuracy=5, captured_at=start)
		previous = frappe._dict(**initial, name="initial", as_dict=lambda: initial)
		gps_rows = []
		legs = []

		def insert(doctype, **values):
			if doctype == "DSR Travel Leg":
				legs.append(values)
				return
			row = frappe._dict(**values, name=f"point-{len(gps_rows)}", as_dict=lambda: values)
			gps_rows.append(row)
			return row

		with (
			patch.object(api, "duty_doc", return_value=duty),
			patch.object(api, "identity"),
			patch.object(
				api,
				"settings",
				return_value=frappe._dict(max_accuracy_m=50, max_speed_kmh=160, max_gap_seconds=300),
			),
			patch.object(api, "now_datetime", return_value=now),
			patch("frappe.utils.get_system_timezone", return_value="Asia/Kolkata"),
			patch.object(frappe, "get_doc", return_value=previous),
			patch.object(frappe, "db", Mock(get_value=Mock(return_value=None), sql=Mock(return_value=[[0]]))),
			patch.object(api, "locked_exists", return_value=False),
			patch.object(api, "insert", side_effect=insert),
			patch.object(api, "event") as event,
			patch.object(api, "save"),
		):
			result = api.gps_batch.__wrapped__(
				"duty",
				[
					dict(
						id="recovery-next",
						latitude=28.002,
						longitude=77,
						accuracy=5,
						captured_at="2026-11-23T01:26:00Z",
					),
					dict(
						id="recovery-first",
						latitude=28.001,
						longitude=77,
						accuracy=5,
						captured_at="2026-11-23T06:55:30+05:30",
					),
				],
			)

		self.assertEqual([row.latitude for row in gps_rows], [28.001, 28.002])
		self.assertEqual(gps_rows[0].distance_km, 0)
		self.assertAlmostEqual(legs[0]["distance_km"], 0.1112, places=4)
		self.assertEqual(legs[0]["duration_seconds"], 30)
		self.assertEqual(result["location"]["captured_at"], "2026-11-23T06:56:00+05:30")
		self.assertEqual(result["gps_status"], "Tracking")
		event.assert_called_once()


class TestEstimatedGPSDistance(unittest.TestCase):
	def test_coarse_moving_fix_is_estimated_but_not_verified(self):
		from srv_erp.smart_dsr.policy import estimated_segment

		previous = dict(latitude=28, longitude=77, accuracy=100)
		current = dict(latitude=28.01, longitude=77, accuracy=100)
		self.assertGreater(estimated_segment(previous, current, 60), 0.8)
		self.assertEqual(segment(previous, current, 60)[0], 0)

	def test_stationary_drift_and_unreliable_intervals_add_no_estimate(self):
		from srv_erp.smart_dsr.policy import estimated_segment

		previous = dict(latitude=28, longitude=77, accuracy=100)
		nearby = dict(latitude=28.0001, longitude=77, accuracy=100)
		moving = dict(latitude=28.01, longitude=77, accuracy=100)
		self.assertEqual(estimated_segment(previous, nearby, 60), 0)
		self.assertEqual(estimated_segment(previous, moving, 301), 0)
		self.assertEqual(estimated_segment(previous, moving, 0), 0)
		self.assertEqual(estimated_segment(previous, moving, 1), 0)
		moving["accuracy"] = 5000
		self.assertEqual(estimated_segment(previous, moving, 60), 0)
