import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api, night_stay


class TestNightStayDutyWait(unittest.TestCase):
	def test_two_hour_boundary_latest_checkout_and_scope(self):
		start = datetime(2026, 11, 21, 8)
		doc = frappe._dict(
			name="duty", account="sales", status="Active", started_at=start - timedelta(days=1)
		)
		for seconds, remaining in [(0, 7200), (7199, 1), (7200, 0), (10800, 0)]:
			with (
				self.subTest(seconds=seconds),
				patch.object(frappe, "get_all", return_value=[frappe._dict(checked_out_at=start)]) as query,
				patch.object(frappe, "db", Mock(exists=Mock(return_value=False))),
				patch.object(api, "now_datetime", return_value=start + timedelta(seconds=seconds)),
			):
				self.assertEqual(night_stay.duty_off_wait(doc)["remaining_seconds"], remaining)
				self.assertEqual(query.call_args.kwargs["filters"]["account"], "sales")
				self.assertEqual(query.call_args.kwargs["filters"]["duty"], "duty")
				self.assertEqual(query.call_args.kwargs["order_by"], "checked_out_at desc")

	def test_no_checkout_does_not_restrict_duty_off(self):
		with patch.object(frappe, "get_all", return_value=[]):
			self.assertEqual(
				night_stay.duty_off_wait(frappe._dict(status="Active", account="sales", name="duty"))[
					"remaining_seconds"
				],
				0,
			)

	def test_reopened_time_off_does_not_count(self):
		start = datetime(2026, 11, 21, 8)
		doc = frappe._dict(
			name="duty", account="sales", status="Active", started_at=start - timedelta(days=1)
		)

		def rows(dt, **kwargs):
			if dt == "DSR Night Stay":
				return [frappe._dict(checked_out_at=start)]
			return [
				frappe._dict(
					recorded_at=start + timedelta(hours=2),
					original_value=frappe.as_json({"ended_at": str(start + timedelta(minutes=30))}),
				)
			]

		with (
			patch.object(frappe, "get_all", side_effect=rows),
			patch.object(frappe, "db", Mock(exists=Mock(return_value=True))),
			patch.object(api, "now_datetime", return_value=start + timedelta(hours=3)),
		):
			self.assertEqual(night_stay.duty_off_wait(doc)["remaining_seconds"], 1800)

	def test_preflight_and_direct_duty_off_enforce_wait(self):
		doc = frappe._dict(name="duty", account="sales", status="Active")
		with (
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(api, "locked_exists", return_value=False),
			patch.object(frappe, "db", Mock(exists=Mock(return_value=False))),
			patch.object(
				night_stay,
				"duty_off_wait",
				return_value={"remaining_seconds": 3600, "message": "Wait after Night Stay OFF"},
			),
			patch.object(frappe, "throw", side_effect=frappe.ValidationError),
		):
			self.assertFalse(api.duty_off_readiness.__wrapped__("duty")["ready"])
			with self.assertRaises(frappe.ValidationError):
				api.duty_off.__wrapped__("duty")
