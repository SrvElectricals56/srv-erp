import unittest
from unittest.mock import patch

import frappe

from srv_erp.srv_erp.doctype.dsr.dsr import DSR


class TestDSRBalance(unittest.TestCase):
	def setUp(self):
		settings = patch("frappe.get_system_settings", return_value="Commercial Rounding")
		settings.start()
		self.addCleanup(settings.stop)

	def calculate(self, **values):
		doc = frappe._dict(
			opening_balance=10000,
			amount_for_travel=900,
			fuel_added=1,
			amount_paid=800,
			daily_sales_expenses_by_admin=[frappe._dict(amount=1000), frappe._dict(amount=500)],
			closing_balance=999999,
			precision=lambda field: 2,
		)
		doc.update(values)
		DSR.set_daily_balance(doc)
		return doc

	def test_expenses_and_fuel_without_travel(self):
		doc = self.calculate()
		self.assertEqual(doc.daily_expenses_total, 1500)
		self.assertEqual(doc.fuel_expenses_total, 800)
		self.assertEqual(doc.closing_balance, 7700)

	def test_unchecked_fuel_ignores_amount_paid(self):
		self.assertEqual(self.calculate(fuel_added=0).closing_balance, 8500)

	def test_removing_expenses_restores_balance(self):
		self.assertEqual(self.calculate(daily_sales_expenses_by_admin=[]).closing_balance, 9200)

	def test_currency_rounding_and_overdrawn_balance(self):
		doc = self.calculate(
			opening_balance=1,
			fuel_added=0,
			daily_sales_expenses_by_admin=[frappe._dict(amount=1.1), frappe._dict(amount=0.2)],
		)
		self.assertEqual(doc.closing_balance, -0.3)

	def test_repeated_calculation_replaces_manual_closing_balance(self):
		doc = self.calculate()
		doc.closing_balance = 50000
		DSR.set_daily_balance(doc)
		self.assertEqual(doc.closing_balance, 7700)

	def check_opening_permission(self, user, amount, stored=None, roles=None):
		doc = frappe._dict(
			opening_balance=amount,
			precision=lambda field: 2,
			get_doc_before_save=lambda: frappe._dict(opening_balance=stored) if stored is not None else None,
		)
		with (
			patch("frappe.session", frappe._dict(user=user)),
			patch("frappe.get_roles", return_value=roles or ["Sales User"]),
			patch("srv_erp.srv_erp.doctype.dsr.dsr._", side_effect=lambda message: message),
			patch("frappe.throw", side_effect=frappe.PermissionError),
		):
			DSR.validate_opening_balance_permissions(doc)
		return doc

	def test_salesperson_cannot_change_or_reset_stored_balance(self):
		for amount in (20000, 0, None):
			with self.subTest(amount=amount), self.assertRaises(frappe.PermissionError):
				self.check_opening_permission("sales@example.com", amount, stored=10000)

	def test_salesperson_cannot_supply_new_opening_balance(self):
		with self.assertRaises(frappe.PermissionError):
			self.check_opening_permission("sales@example.com", 10000)

	def test_salesperson_can_preserve_stored_opening_balance(self):
		self.assertEqual(
			self.check_opening_permission("sales@example.com", 10000, stored=10000).opening_balance,
			10000,
		)

	def test_sales_manager_can_change_opening_balance(self):
		self.assertEqual(
			self.check_opening_permission(
				"manager@example.com", 20000, stored=10000, roles=["Sales Manager"]
			).opening_balance,
			20000,
		)

	def test_other_managers_cannot_change_opening_balance(self):
		for role in ["System Manager", "Accounts Manager"]:
			with self.subTest(role=role), self.assertRaises(frappe.PermissionError):
				self.check_opening_permission("manager@example.com", 20000, stored=10000, roles=[role])

	def test_administrator_can_set_and_change_opening_balance(self):
		self.assertEqual(self.check_opening_permission("Administrator", 10000).opening_balance, 10000)
		self.assertEqual(
			self.check_opening_permission("Administrator", 20000, stored=10000).opening_balance,
			20000,
		)

	def test_collections_increase_closing_without_changing_opening(self):
		doc = self.calculate(lead=[frappe._dict(money_collected=200), frappe._dict(money_collected=300)])
		self.assertEqual(doc.opening_balance, 10000)
		self.assertEqual(doc.closing_balance, 8200)
		DSR.set_daily_balance(doc)
		self.assertEqual(doc.closing_balance, 8200)
		doc.lead = []
		DSR.set_daily_balance(doc)
		self.assertEqual(doc.opening_balance, 10000)
		self.assertEqual(doc.closing_balance, 7700)

	def test_historical_embedded_collections_normalized_on_save(self):
		previous = frappe._dict(opening_balance=10500, money_collected_total=500)
		doc = frappe._dict(opening_balance=10500, get_doc_before_save=lambda: previous)
		with (
			patch("frappe.session", frappe._dict(user="sales@example.com")),
			patch("frappe.get_roles", return_value=["Sales Person"]),
		):
			DSR.validate_opening_balance_permissions(doc)
		self.assertEqual(doc.opening_balance, 10000)
		self.assertEqual(doc.balance_rules_version, 1)

	def test_negative_collection_is_rejected(self):
		with (
			patch("frappe.throw", side_effect=ValueError),
			patch("srv_erp.srv_erp.doctype.dsr.dsr._", side_effect=lambda x: x),
			self.assertRaises(ValueError),
		):
			self.calculate(lead=[frappe._dict(money_collected=-10, idx=1)])
