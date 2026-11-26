"""Rollback-only developer check against an already installed site."""

import unittest

import frappe


def run(modules=None):
	original_user = frappe.session.user
	original_test_flag = frappe.flags.in_test
	frappe.flags.in_test = True
	try:
		suite = unittest.TestSuite(
			unittest.defaultTestLoader.loadTestsFromName(module)
			for module in (
				modules
				or (
					"srv_erp.tests.test_smart_dsr",
					"srv_erp.tests.test_dsr_balance",
					"srv_erp.tests.test_smart_dsr_website",
					"srv_erp.tests.test_smart_dsr_user_login",
					"srv_erp.tests.test_smart_dsr_gps_accuracy",
					"srv_erp.tests.test_smart_dsr_vehicle_number",
					"srv_erp.tests.test_smart_dsr_admin",
				)
			)
		)
		result = unittest.TextTestRunner(verbosity=2).run(suite)
		if not result.wasSuccessful():
			raise RuntimeError(f"Smart DSR: {len(result.failures)} failures, {len(result.errors)} errors")
		return {"tests": result.testsRun, "passed": True}
	finally:
		frappe.db.rollback()
		frappe.flags.in_test = original_test_flag
		frappe.set_user(original_user)
