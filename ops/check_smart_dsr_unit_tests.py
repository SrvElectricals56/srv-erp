"""Run the isolated Smart DSR regression suite without a site or live database."""

import unittest

import frappe

TESTS = (
	"srv_erp.tests.test_collection_balance_methods.TestCollectionBalanceMethods",
	"srv_erp.tests.test_dsr_balance.TestDSRBalance",
	"srv_erp.tests.test_home_collections.TestHomeCollections",
	"srv_erp.tests.test_home_expenses.TestHomeExpenses",
	"srv_erp.tests.test_night_stay_duty_wait.TestNightStayDutyWait",
	"srv_erp.tests.test_party_items.TestPartyItems",
	"srv_erp.tests.test_salesperson_home.TestSalespersonHome",
	"srv_erp.tests.test_smart_dsr_access.TestSmartDSRAccess",
	"srv_erp.tests.test_smart_dsr_admin_pending.TestAdminPendingDuty",
	"srv_erp.tests.test_smart_dsr_async_photo.TestAsyncPhoto",
	"srv_erp.tests.test_smart_dsr_date_format.TestShortDates",
	"srv_erp.tests.test_smart_dsr_dealer_overdues.TestDealerOverdues",
	"srv_erp.tests.test_smart_dsr_dealer_search.TestDealerSearch",
	"srv_erp.tests.test_smart_dsr_delete_visit.TestDeletePendingVisit",
	"srv_erp.tests.test_smart_dsr_duty_readiness.TestDutyReadiness",
	"srv_erp.tests.test_smart_dsr_expense_receipt.TestExpenseReceipts",
	"srv_erp.tests.test_smart_dsr_gps_accuracy.TestGPSAccuracy",
	"srv_erp.tests.test_smart_dsr_gps_accuracy.TestEstimatedGPSDistance",
	"srv_erp.tests.test_smart_dsr_ledger_dealers.TestLedgerDealers",
	"srv_erp.tests.test_smart_dsr_meal_expenses.TestMealCutoffs",
	"srv_erp.tests.test_smart_dsr_meal_expenses.TestMealPosting",
	"srv_erp.tests.test_smart_dsr_night_stay_rules.TestNightStayRules",
	"srv_erp.tests.test_smart_dsr_no_visit_duty.TestNoVisitDuty",
	"srv_erp.tests.test_smart_dsr_odometer.TestOdometer",
	"srv_erp.tests.test_smart_dsr_opening_cash.TestOpeningCash",
	"srv_erp.tests.test_smart_dsr_panel_scope.TestPanelProfileScope",
	"srv_erp.tests.test_smart_dsr_photo_delete.TestPhotoDelete",
	"srv_erp.tests.test_smart_dsr_photo_first.TestPhotoFirstVisit",
	"srv_erp.tests.test_smart_dsr_redirect.TestSmartDSRRedirect",
	"srv_erp.tests.test_smart_dsr_retake.TestVisitRetake",
	"srv_erp.tests.test_smart_dsr_rewards.TestRewardEvidence",
	"srv_erp.tests.test_smart_dsr_rewards.TestRewardScoring",
	"srv_erp.tests.test_smart_dsr_rewards.TestRewardCompletion",
	"srv_erp.tests.test_smart_dsr_route_map.TestRouteSegments",
	"srv_erp.tests.test_smart_dsr_route_map.TestRouteAccess",
	"srv_erp.tests.test_smart_dsr_section_reports.TestSectionReports",
	"srv_erp.tests.test_smart_dsr_vehicle_allocation.TestVehicleAllocation",
	"srv_erp.tests.test_smart_dsr_vehicle_number.TestVehicleNumber",
	"srv_erp.tests.test_smart_dsr_vehicle_number.TestSimpleVehicleForm",
	"srv_erp.tests.test_smart_dsr_visit_dealers.TestVisitDealerOptions",
	"srv_erp.tests.test_smart_dsr_setup.TestSmartDSRInstallation",
	"srv_erp.tests.test_home_direct_balance",
	"srv_erp.tests.test_smart_dsr.TestPolicy",
)


class NoDatabase:
	def __getattr__(self, name):
		raise AssertionError(f"Unit test attempted unmocked database access: {name}")


def main():
	# Each unit test must provide its own database fixtures. Integration tests
	# belong in the installed-site rollback suite, not this isolated runner.
	frappe.local.session = frappe._dict(user="unit-test@example.invalid")
	frappe.local.flags = frappe._dict(in_test=True)
	frappe.local.message_log = []
	frappe.local.db = NoDatabase()
	suite = unittest.defaultTestLoader.loadTestsFromNames(TESTS)
	result = unittest.TextTestRunner(verbosity=1).run(suite)
	return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
	raise SystemExit(main())
