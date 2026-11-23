"""User login and account isolation without creating an Employee or Sales Person."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import api, security


class TestUserLogin(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("user_login_test")
		self.addCleanup(self.cleanup)
		self.user = "dsr-user-" + frappe.generate_hash(length=10) + "@example.invalid"
		frappe.get_doc(
			dict(
				doctype="User",
				email=self.user,
				first_name="Direct User",
				send_welcome_email=0,
				roles=[{"role": "Sales Person"}],
			)
		).insert(ignore_permissions=True)
		company = frappe.get_all("Company", pluck="name", limit=1)[0]
		frappe.db.set_single_value("DSR Settings", "company", company)
		api.initialize_balance(self.user, 1000, "user-initial-cash", "Rollback-only login test")
		frappe.set_user(self.user)
		self.gps = dict(latitude=28.0, longitude=77.0, accuracy=5)
		api.add_vehicle(
			{
				"registration_number": "PB31AB1234",
				"vehicle_type": "Car",
				"make": "Test",
				"model": "Direct",
				"fuel_type": "CNG",
				"insurance_number": "INS",
				"insurance_expiry": "2099-12-31",
				"puc_number": "PUC",
				"puc_expiry": "2099-12-31",
				"rc_number": "RC",
				"rc_expiry": "2099-12-31",
				"fastag_details": "FASTAG",
			}
		)

	def cleanup(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="user_login_test")
		frappe.clear_cache(user=self.user)

	def start(self):
		return api.duty_on(
			"PB31AB1234",
			"CNG",
			"Home",
			self.gps,
			"user-duty-on",
			documents=dict(insurance=True, puc=True, rc=True, fastag=True),
		)["duty"]["name"]

	def test_existing_user_needs_no_employee_or_salesperson(self):
		self.assertFalse(frappe.db.exists("Employee", {"user_id": self.user}))
		self.assertFalse(frappe.db.exists("Sales Person", {"sales_user": self.user}))
		self.assertEqual(api.identity(), self.user)
		profile = api.bootstrap()
		self.assertEqual(profile["account"], self.user)
		self.assertEqual(profile["employee_name"], "Direct User")
		self.assertIsNone(profile["sales_person"])

	def test_sales_role_is_a_login_requirement(self):
		with patch.object(frappe, "get_roles", return_value=["All", "Guest"]):
			with self.assertRaises(frappe.PermissionError):
				api.identity()

	def test_guest_cannot_use_dsr(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.AuthenticationError):
			api.identity()

	def test_disabled_user_is_rejected(self):
		frappe.db.set_value("User", self.user, "enabled", 0)
		with self.assertRaises(frappe.PermissionError):
			api.identity()

	def test_user_can_start_and_finalize_own_duty_without_hr(self):
		name = self.start()
		doc = frappe.get_doc("DSR Duty Session", name)
		self.assertEqual(doc.account, self.user)
		self.assertFalse(doc.employee)
		self.assertEqual(api.summary(name)["available_cash"], 1000)
		self.assertEqual(api.end_workday(name, self.gps)["duty"]["status"], "Finalized")

	def test_other_users_cannot_read_my_duty(self):
		name = self.start()
		frappe.set_user("Administrator")
		other = frappe.get_doc(
			dict(
				doctype="User",
				email="other-" + frappe.generate_hash(length=10) + "@example.invalid",
				first_name="Other",
				send_welcome_email=0,
			)
		).insert(ignore_permissions=True)
		other.add_roles("Sales Person")
		frappe.set_user(other.name)
		with self.assertRaises(frappe.PermissionError):
			api.summary(name)
		self.assertFalse(
			security.permission(
				frappe.get_doc("DSR Duty Session", name), user=other.name, permission_type="read"
			)
		)

	def test_only_administrator_initializes_cash(self):
		with self.assertRaises(frappe.PermissionError):
			api.initialize_balance(self.user, 500, "cash-attack-key", "Not authorized")

	def test_customer_permissions_are_not_granted_by_login(self):
		self.assertFalse(frappe.has_permission("Customer", "read"))
		with self.assertRaises(frappe.PermissionError):
			api.search_dealers()

	def test_administrator_opens_without_employee(self):
		frappe.set_user("Administrator")
		self.assertEqual(api.bootstrap()["account"], "Administrator")

	def test_unconfigured_company_does_not_block_login(self):
		frappe.db.set_single_value("DSR Settings", "company", None)
		self.assertFalse(api.bootstrap()["configured"])

	def test_legacy_employee_field_is_preserved(self):
		field = frappe.get_meta("DSR Duty Session").get_field("employee")
		self.assertEqual(field.options, "Employee")
		self.assertFalse(field.reqd)

	def test_approximate_gps_allows_duty_without_verified_distance(self):
		self.gps["accuracy"] = 5000
		name = self.start()
		result = api.summary(name)
		self.assertEqual(result["duty"]["status"], "Active")
		self.assertEqual(result["duty"]["verified_km"], 0)
		self.assertEqual(result["duty"]["gps_status"], "Interrupted")
		point = frappe.get_doc("DSR GPS Point", result["duty"]["last_point"])
		self.assertEqual(point.accuracy, 5000)
		self.assertFalse(point.verified)
		self.assertEqual(point.rejection_reason, "Poor accuracy")
		final = api.end_workday(name, self.gps)
		self.assertEqual(final["duty"]["status"], "Finalized")
		self.assertEqual(final["duty"]["verified_km"], 0)
		self.assertEqual(final["available_cash"], 1000)


class TestHistoricalAccountMigration(unittest.TestCase):
	from srv_erp.tests import test_smart_dsr as _fixtures

	setUp = _fixtures.TestSmartDSR.setUp
	cleanup = _fixtures.TestSmartDSR.cleanup

	def test_existing_ledger_is_relinked_without_reposting(self):
		from srv_erp.smart_dsr.setup import backfill_user_accounts

		frappe.set_user("Administrator")
		name = frappe.db.get_value(
			"DSR Cash Ledger", {"account": self.user, "transaction_type": "Opening"}, "name"
		)
		before = frappe.db.count("DSR Cash Ledger")
		frappe.db.set_value(
			"DSR Cash Ledger",
			name,
			dict(account=None, employee=self.employee, request_key=api.key("legacy-opening", self.employee)),
		)
		backfill_user_accounts(["DSR Cash Ledger"])
		row = frappe.get_doc("DSR Cash Ledger", name)
		self.assertEqual(row.account, self.user)
		self.assertEqual(row.employee, self.employee)
		self.assertEqual(row.amount, 1000)
		self.assertEqual(frappe.db.count("DSR Cash Ledger"), before)
		self.assertEqual(
			api.initialize_balance(self.user, 1000, "legacy-opening", "Retry prior operation"), name
		)
