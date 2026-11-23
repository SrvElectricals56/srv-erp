"""Routes preserve gaps and enforce the existing administrator/report scope."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin, api
from srv_erp.smart_dsr.route_map import route_segments


class TestRouteSegments(unittest.TestCase):
	def point(self, minutes, latitude=28, accuracy=5, verified=1):
		return dict(
			latitude=latitude,
			longitude=77,
			accuracy=accuracy,
			verified=verified,
			captured_at=datetime(2026, 11, 17, 9) + timedelta(minutes=minutes),
		)

	def test_merges_continuous_verified_segments(self):
		segments, gaps = route_segments([self.point(0), self.point(1, 28.001), self.point(2, 28.002)])
		self.assertEqual(len(segments), 1)
		self.assertEqual(segments[0]["kind"], "verified")
		self.assertEqual(len(segments[0]["coordinates"]), 3)
		self.assertEqual(gaps, [])

	def test_coarse_readings_are_approximate(self):
		segments, gaps = route_segments([self.point(0), self.point(1, 28.001, 200, 0)])
		self.assertEqual(segments[0]["kind"], "approximate")
		self.assertEqual(gaps, [])

	def test_missing_time_implausible_speed_and_very_poor_accuracy_are_not_connected(self):
		for current in (
			self.point(10, 28.001),
			self.point(1, 40),
			self.point(1, 28.001, 5000, 0),
			self.point(0),
		):
			with self.subTest(current=current):
				segments, gaps = route_segments([self.point(0), current])
				self.assertEqual(segments, [])
				self.assertEqual(len(gaps), 1)

	def test_route_does_not_bridge_across_gap(self):
		segments, gaps = route_segments(
			[self.point(0), self.point(1, 28.001), self.point(10, 28.002), self.point(11, 28.003)]
		)
		self.assertEqual(len(segments), 2)
		self.assertEqual(len(gaps), 1)

	def test_short_reported_interruption_is_a_gap_before_a_verified_segment(self):
		first = self.point(0)
		recovery = dict(self.point(1, 28.001, verified=0), rejection_reason="Unverified interval")
		last = self.point(2, 28.002)
		segments, gaps = route_segments([first, recovery, last])
		self.assertEqual([segment["kind"] for segment in segments], ["verified"])
		self.assertEqual(segments[0]["started_at"], recovery["captured_at"])
		self.assertEqual(len(gaps), 1)
		self.assertEqual((gaps[0]["from"], gaps[0]["to"]), (first["captured_at"], recovery["captured_at"]))

	def test_empty_and_single_point_routes(self):
		self.assertEqual(route_segments([]), ([], []))
		self.assertEqual(route_segments([self.point(0)]), ([], []))


class TestRouteAccess(unittest.TestCase):
	def setUp(self):
		stub = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		stub.start()
		self.addCleanup(stub.stop)

	def test_non_admin_is_rejected_before_reading_gps(self):
		with (
			patch.object(admin, "require_admin", side_effect=frappe.PermissionError),
			patch.object(frappe, "get_all") as query,
		):
			with self.assertRaises(frappe.PermissionError):
				admin.duty_route("duty")
			query.assert_not_called()

	def test_record_scope_is_enforced(self):
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "conditions", return_value={"account": ["in", ["allowed"]]}),
			patch.object(frappe, "db", Mock()) as db,
			patch.object(frappe, "get_all") as query,
			patch.object(frappe, "throw", side_effect=frappe.PermissionError),
		):
			db.exists.return_value = False
			with self.assertRaises(frappe.PermissionError):
				admin.duty_route("other-duty")
			query.assert_not_called()
			self.assertEqual(db.exists.call_args.args[1]["account"], ["in", ["allowed"]])

	def test_full_route_is_duty_scoped_and_stops_at_duty_off(self):
		doc = frappe._dict(
			name="duty",
			account="allowed",
			started_at=datetime(2026, 11, 17, 9),
			ended_at=datetime(2026, 11, 17, 18),
			status="Finalized",
			verified_km=12,
			estimated_km=13,
		)
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "conditions", return_value={}),
			patch.object(frappe, "db", Mock()),
			patch.object(frappe, "get_doc", return_value=doc),
			patch.object(frappe, "get_all", return_value=[]) as query,
			patch.object(
				api,
				"settings",
				return_value=frappe._dict(max_gap_seconds=300, max_speed_kmh=160, max_accuracy_m=50),
			),
			patch.object(api, "public_dates", side_effect=lambda value: value),
		):
			result = admin.duty_route("duty")
			filters = query.call_args_list[0].kwargs["filters"]
			self.assertEqual(filters["duty"], "duty")
			self.assertEqual(filters["account"], "allowed")
			self.assertEqual(filters["captured_at"], ["between", [doc.started_at, doc.ended_at]])
			self.assertEqual(query.call_args_list[0].kwargs["limit_page_length"], 0)
			self.assertEqual(result["points"], [])
