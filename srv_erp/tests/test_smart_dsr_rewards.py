"""Reward evidence requires time near the shop, without counting GPS gaps."""

import unittest
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import rewards


class TestRewardEvidence(unittest.TestCase):
	def sample(self, minute, **values):
		return dict(
			latitude=28,
			longitude=77,
			accuracy=5,
			captured_at=datetime(2026, 11, 17) + timedelta(minutes=minute),
			verified=True,
			**values,
		)

	def test_counts_time_inside_fence(self):
		self.assertEqual(rewards.near_seconds(self.sample(0), [self.sample(n) for n in range(31)]), 1800)

	def test_does_not_count_missing_gps(self):
		self.assertEqual(rewards.near_seconds(self.sample(0), [self.sample(0), self.sample(30)]), 0)

	def test_approximate_photo_anchor_cannot_verify_nearby_time(self):
		for accuracy in (None, 700):
			center = dict(self.sample(0), accuracy=accuracy)
			self.assertEqual(rewards.near_seconds(center, [self.sample(0), self.sample(1)]), 0)

	def test_dealer_fence_accounts_for_uncertainty_of_both_fixes(self):
		center = dict(self.sample(0), accuracy=25)
		samples = [dict(self.sample(minute), latitude=28.00425, accuracy=10) for minute in (0, 1)]
		self.assertEqual(rewards.near_seconds(center, samples), 0)

	def test_outside_and_unverified_samples_break_interval(self):
		for change in ({"latitude": 29}, {"accuracy": 100}, {"verified": False}):
			middle = self.sample(1)
			middle.update(change)
			self.assertEqual(
				rewards.near_seconds(self.sample(0), [self.sample(0), middle, self.sample(2)]), 0
			)

	def test_reported_interruption_breaks_a_short_interval(self):
		center = self.sample(0)
		interruptions = [self.sample(1)["captured_at"]]
		self.assertEqual(
			rewards.near_seconds(center, [center, self.sample(3)], interruptions=interruptions), 0
		)

	def test_first_fresh_recovery_fix_anchors_only_the_outgoing_interval(self):
		center = self.sample(0)
		recovery = dict(
			self.sample(1),
			verified=False,
			rejection_reason="Unverified interval",
			received_at=self.sample(2)["captured_at"],
		)
		self.assertEqual(rewards.near_seconds(center, [center, recovery, self.sample(2)]), 60)
		recovery["received_at"] = self.sample(8)["captured_at"]
		self.assertEqual(rewards.near_seconds(center, [center, recovery, self.sample(2)]), 0)

	def test_retake_keeps_original_timer(self):
		row = frappe._dict(reward_started_at="2026-11-17 10:00:00")
		with patch("srv_erp.smart_dsr.api.save") as save:
			rewards.start_timer(row, frappe._dict(received_at="2026-11-17 10:10:00"))
			save.assert_not_called()


class TestRewardScoring(unittest.TestCase):
	def test_image_policy_boundaries_and_whole_multiples(self):
		for seconds, minimum, threshold, multiplier in (
			(0, 20000, 40000, 1),
			(1800, 20000, 40000, 1),
			(1800.001, 75000, 150000, 2),
			(3600, 75000, 150000, 2),
			(3600.001, 200000, 300000, 3),
			(7200, 200000, 300000, 3),
			(7200.001, 300000, 400000, 4),
			(10800, 300000, 400000, 4),
			(10800.001, 400000, 500000, 5),
			(20000, 400000, 500000, 5),
		):
			for amount, expected in (
				(0, -1),
				(minimum - 0.01, -1),
				(minimum, 0),
				(threshold - 0.01, 0),
				(threshold, multiplier),
				(threshold * 1.5, multiplier),
				(threshold * 2, multiplier * 2),
			):
				with self.subTest(seconds=seconds, amount=amount):
					self.assertEqual(rewards.score_visit(seconds, amount), (expected, threshold, 1))

	def test_half_hour_example_remains_19_points(self):
		self.assertEqual(rewards.score_visit(1800, 799999)[0], 19)

	def test_total_preserves_historical_fractional_points(self):
		with patch.object(frappe, "db", frappe._dict(sql=lambda *args: [[1.5]])):
			self.assertEqual(rewards.total_points("user"), 1.5)

	def test_snapshot_is_written_once(self):
		row = frappe._dict(reward_started_at="2026-11-17 10:00:00")
		with patch.object(
			rewards,
			"visit_evidence",
			return_value=(3600, 150000, [{"order": "SO-1", "amount_inr": "150000"}]),
		) as evidence:
			rewards.finalize_reward(row, "2026-11-17 11:00:00", {})
			self.assertEqual(row.reward_points, 2)
			rewards.finalize_reward(row, "2026-11-17 12:00:00", {})
			evidence.assert_called_once()

	def test_historical_visit_without_timer_is_not_scored(self):
		with patch.object(rewards, "visit_evidence") as evidence:
			rewards.finalize_reward(frappe._dict(), "2026-11-17 12:00:00", {})
			evidence.assert_not_called()

	def test_submission_freezes_snapshot_and_cannot_award_twice(self):
		row = frappe._dict(name="visit", reward_started_at="2026-11-17 10:00:00")
		with patch.object(
			rewards, "visit_evidence", return_value=(1800, rewards.money(40000), [{"order": "SO-1"}])
		) as evidence:
			rewards.finalize_reward(row, "2026-11-17 10:30:00", {})
			self.assertEqual(row.reward_points, 1)
			self.assertEqual(row.reward_order_amount, 40000)
			rewards.finalize_reward(row, "2026-11-17 12:30:00", {})
			evidence.assert_called_once()
			self.assertEqual(row.reward_points, 1)

	def test_old_visit_without_timer_is_unchanged(self):
		row = frappe._dict(name="old-visit")
		with patch.object(rewards, "visit_evidence") as evidence:
			rewards.finalize_reward(row, "2026-11-17 10:30:00", {})
			evidence.assert_not_called()
			self.assertIsNone(row.reward_rule_version)

	def test_evidence_counts_only_linked_orders_and_uses_inr(self):
		row = frappe._dict(
			name="visit",
			account="user",
			duty="duty",
			customer="Dealer",
			reward_started_at="2026-11-17 10:00:00",
			reward_latitude=28,
			reward_longitude=77,
		)
		orders = [
			frappe._dict(name="SO-1", currency="INR", grand_total=20000, company="Company"),
			frappe._dict(
				name="SO-2", currency="USD", grand_total=100, base_grand_total=9000, company="Company"
			),
		]
		photo = frappe._dict(latitude=28, longitude=77, accuracy=5)
		with (
			patch.object(frappe, "db", Mock(get_value=Mock(side_effect=[photo, None]))) as db,
			patch.object(frappe, "get_all", side_effect=[[], [], orders]) as query,
			patch.object(frappe, "get_cached_value", return_value="INR"),
		):
			seconds, amount, accepted = rewards.visit_evidence(
				row, "2026-11-17 10:01:00", dict(latitude=28, longitude=77, accuracy=5)
			)
			self.assertEqual(seconds, 60)
			self.assertEqual(amount, 29000)
			self.assertEqual(len(accepted), 2)
			photo_filters = db.get_value.call_args_list[0].args[1]
			self.assertEqual(photo_filters["activity"], "visit")
			self.assertEqual(photo_filters["received_at"], datetime(2026, 11, 17, 10))
			filters = query.call_args.kwargs["filters"]
			self.assertEqual(filters["custom_dsr_visit"], "visit")
			self.assertEqual(filters["customer"], "Dealer")
			self.assertEqual(filters["docstatus"], ["<", 2])


class TestRewardCompletion(unittest.TestCase):
	def setUp(self):
		local = patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False)))
		local.start()
		self.addCleanup(local.stop)

	def test_repeated_completion_does_not_score_again(self):
		from srv_erp.smart_dsr import api

		row = frappe._dict(name="visit", duty="duty", account="user", status="Completed")
		with (
			patch.object(frappe, "get_doc", return_value=row),
			patch.object(api, "duty_doc", return_value=frappe._dict(account="user")),
			patch.object(rewards, "finalize_reward") as finalize,
		):
			self.assertEqual(api.complete_activity("visit", {}), "visit")
			finalize.assert_not_called()

	def test_submission_scores_before_saving_completed_visit(self):
		from srv_erp.smart_dsr import api

		row = frappe._dict(
			name="visit", duty="duty", account="user", status="Open", arrived_at=datetime(2026, 11, 17)
		)
		doc = frappe._dict(account="user")
		with (
			patch.object(frappe, "get_doc", return_value=row),
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(api, "activity_doc", return_value=(row, doc)),
			patch.object(api, "valid_photo", return_value=True),
			patch.object(frappe, "db", Mock(exists=Mock(return_value=False))),
			patch.object(api, "location", return_value=dict(latitude=28, longitude=77, accuracy=5)),
			patch.object(api, "now_datetime", return_value=datetime(2026, 11, 17, 1)),
			patch.object(api, "settings", return_value=frappe._dict(max_gap_seconds=300)),
			patch.object(api, "save"),
			patch.object(api, "recalculate"),
			patch.object(rewards, "finalize_reward") as finalize,
		):
			self.assertEqual(api.complete_activity("visit", {}), "visit")
			finalize.assert_called_once()
			self.assertEqual(finalize.call_args.args[1], row.departed_at)
			self.assertEqual(row.status, "Completed")
