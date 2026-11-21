"""Approximate browser fixes are recorded, never upgraded to verified distance."""

import unittest
from unittest.mock import patch

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
