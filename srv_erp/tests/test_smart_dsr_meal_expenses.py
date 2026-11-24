"""Exact IST cutoffs, continuous-duty eligibility, and once-only meal charges."""

import unittest
from datetime import date, datetime
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import api
from srv_erp.smart_dsr import meal_expenses as meals


def stamp(value):
	return datetime.fromisoformat("2026-11-16T" + value).replace(tzinfo=meals.INDIA)


class TestMealCutoffs(unittest.TestCase):
	def test_meal_boundaries_and_amounts(self):
		for start, now, expected in (
			("07:00:00", "07:04:59", []),
			("07:00:00", "07:05:00", [("Breakfast", 100)]),
			("07:00:00.000001", "07:05:00", []),
			("12:59:59", "13:29:59", []),
			("12:59:59", "13:30:00", [("Lunch", 150)]),
			("13:00:00", "13:30:00", []),
			("17:59:59", "21:29:59", []),
			("17:59:59", "21:30:00", [("Dinner", 150)]),
			("18:00:00", "21:30:00", []),
			("06:00:00", "22:00:00", [("Breakfast", 100), ("Lunch", 150), ("Dinner", 150)]),
		):
			with self.subTest(start=start, now=now):
				self.assertEqual(
					[(name, amount) for name, amount, _ in meals.due_meals(stamp(start), stamp(now))],
					expected,
				)

	def test_meals_repeat_at_same_time_after_24_hours(self):
		end = stamp("07:05:00").replace(day=18)
		rows = list(meals.due_meals(stamp("06:00:00"), end))
		self.assertEqual(
			[name for name, _, _ in rows],
			["Breakfast", "Lunch", "Dinner", "Breakfast", "Lunch", "Dinner", "Breakfast"],
		)
		breakfasts = [at for name, _, at in rows if name == "Breakfast"]
		self.assertEqual((breakfasts[1] - breakfasts[0]).total_seconds(), 86400)

	def test_reopening_after_cutoff_does_not_qualify_for_earlier_meal(self):
		doc = frappe._dict(name="duty", started_at=stamp("06:00:00"))
		with patch.object(frappe, "get_all", return_value=[frappe._dict(recorded_at=stamp("13:10:00"))]):
			start = meals.continuous_start(doc)
		self.assertEqual(
			[name for name, _, _ in meals.due_meals(start, stamp("22:00:00"), date(2026, 11, 16))], ["Dinner"]
		)

	def test_naive_site_time_is_converted_to_ist(self):
		with patch.object(meals, "get_system_timezone", return_value="UTC"):
			self.assertEqual(meals.india_time(datetime(2026, 11, 16, 1, 30)), stamp("07:00:00"))


class TestMealPosting(unittest.TestCase):
	def test_scheduled_meals_post_cash_deductions_once(self):
		doc = frappe._dict(
			name="duty", account="user", status="Active", started_at=stamp("06:00:00"), opening_balance=1000
		)
		seen = set()
		movements = []
		expenses = []

		def insert(dt, **values):
			seen.add(values["request_key"])
			row = frappe._dict(doctype=dt, name="meal-" + str(len(expenses)), **values)
			expenses.append(row)
			return row

		def ledger(*args):
			movements.append(args[2])
			return frappe._dict(posting_time=None)

		def recalculate(row):
			row.closing_balance = row.opening_balance + sum(movements)

		with (
			patch.object(meals, "automatic_meals_enabled", return_value=True),
			patch.object(meals, "continuous_start", return_value=doc.started_at),
			patch.object(meals, "get_system_timezone", return_value="Asia/Kolkata"),
			patch.object(api, "key", side_effect=lambda value, account: account + ":" + value),
			patch.object(
				api, "repeated", side_effect=lambda dt, value, account: account + ":" + value in seen
			),
			patch.object(api, "insert", side_effect=insert),
			patch.object(api, "ledger", side_effect=ledger),
			patch.object(api, "save"),
			patch.object(api, "recalculate", side_effect=recalculate),
		):
			self.assertEqual(len(meals.post_due_meals(doc, stamp("07:05:00"))), 1)
			self.assertEqual(doc.closing_balance, 900)
			self.assertEqual(meals.post_due_meals(doc, stamp("07:05:00")), [])
			self.assertEqual(len(meals.post_due_meals(doc, stamp("13:30:00"))), 1)
			self.assertEqual(doc.closing_balance, 750)
			self.assertEqual(len(meals.post_due_meals(doc, stamp("21:30:00"))), 1)
			self.assertEqual(doc.closing_balance, 600)
			self.assertEqual(meals.post_due_meals(doc, stamp("22:00:00")), [])
			self.assertEqual(len(meals.post_due_meals(doc, stamp("07:05:00").replace(day=17))), 1)
			self.assertEqual(meals.post_due_meals(doc, stamp("07:05:00").replace(day=17)), [])
			self.assertEqual(doc.closing_balance, 500)
		self.assertEqual(movements, [-100, -150, -150, -100])
		self.assertEqual([row.category for row in expenses], ["Breakfast", "Lunch", "Dinner", "Breakfast"])
		self.assertTrue(all(row.paid_from_cash for row in expenses))
		self.assertEqual(
			[row.recorded_at.time().isoformat() for row in expenses],
			["07:05:00", "13:30:00", "21:30:00", "07:05:00"],
		)

	def test_closed_or_finalized_duty_cannot_receive_expenses(self):
		for status in ("Closed", "Finalized"):
			with self.subTest(status=status), patch.object(api, "insert") as insert:
				self.assertEqual(meals.post_due_meals(frappe._dict(status=status)), [])
				insert.assert_not_called()

	def test_historical_duty_before_enable_date_is_not_changed(self):
		with patch.object(frappe, "db", Mock()):
			frappe.db.get_single_value.return_value = "2026-11-16"
			self.assertFalse(
				meals.automatic_meals_enabled(
					frappe._dict(started_at=datetime(2026, 11, 15, tzinfo=meals.INDIA))
				)
			)

	def test_unset_activation_date_cannot_enable_historical_charges(self):
		with patch.object(frappe, "db", Mock()):
			frappe.db.get_single_value.return_value = date.min
			self.assertFalse(meals.automatic_meals_enabled(frappe._dict(started_at=stamp("06:00:00"))))

	def test_new_rules_do_not_add_legacy_meal_allowances(self):
		with (
			patch.object(meals, "automatic_meals_enabled", return_value=True),
			patch.object(frappe, "db", Mock()),
		):
			self.assertEqual(meals.legacy_allowance(frappe._dict(name="duty")), 0)
			frappe.db.sql.assert_not_called()

	def test_duty_off_catches_up_before_status_changes(self):
		doc = frappe._dict(name="duty", status="Active", gps_exception="Authorized ending GPS exception")

		def catch_up(row):
			self.assertEqual(row.status, "Active")

		with (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(api, "duty_doc", return_value=doc),
			patch.object(
				api,
				"locked_exists",
				side_effect=lambda dt, filters: dt == "DSR Dealer Activity"
				and filters.get("status") == "Completed",
			),
			patch.object(meals, "post_due_meals", side_effect=catch_up) as post,
			patch("srv_erp.smart_dsr.night_stay.duty_off_wait", return_value={"remaining_seconds": 0}),
			patch.object(api, "now_datetime", return_value=stamp("13:31:00")),
			patch.object(api, "recalculate"),
			patch.object(api, "save"),
			patch.object(api, "event"),
			patch.object(api, "summary", return_value={}),
		):
			api.duty_off("duty", None)
			post.assert_called_once_with(doc)
			self.assertEqual(doc.status, "Closed")
