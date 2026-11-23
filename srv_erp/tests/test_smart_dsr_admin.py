"""Control-panel regressions use transaction-scoped business fixtures."""

import io
import json
import unittest

import frappe
from frappe.utils import getdate

from srv_erp.smart_dsr import admin, admin_permissions, api, security
from srv_erp.tests import test_smart_dsr as fixtures


class TestAdministratorPanel(unittest.TestCase):
	setUp = fixtures.TestSmartDSR.setUp
	cleanup = fixtures.TestSmartDSR.cleanup
	start = fixtures.TestSmartDSR.start

	def administrator(self):
		frappe.set_user("Administrator")

	def manager_profile(self):
		if not frappe.db.exists("Role Profile", "Sales Manager"):
			frappe.get_doc(
				{
					"doctype": "Role Profile",
					"role_profile": "Sales Manager",
					"roles": [{"role": "Sales Manager"}],
				}
			).insert(ignore_permissions=True)
		return "Sales Manager"

	def role(self, role):
		self.administrator()
		doc = frappe.get_doc("User", self.user)
		doc.add_roles(role)
		if role == "Sales Manager":
			doc.role_profile_name = self.manager_profile()
			doc.save(ignore_permissions=True)
		frappe.set_user(self.user)

	def test_salesperson_and_guest_cannot_call_administrative_apis(self):
		calls = [
			lambda: admin.bootstrap(),
			lambda: admin.list_records("duties"),
			lambda: admin.overview(),
			lambda: admin.balance_details(self.user),
			lambda: admin.details("people", self.user),
			lambda: admin.report("Daily"),
			lambda: admin.export_report("Daily"),
			lambda: admin.opening_balance(self.user, 50, "test", "forbidden-key"),
			lambda: admin.cash_adjustment("x", "Authorized Adjustment", 1, "test", "forbidden-key"),
			lambda: admin.manage_user(self.user, "test", "forbidden-key"),
			lambda: admin.correct_metadata("duties", "x", {}, "test", "forbidden-key"),
			lambda: admin.post_payment("x", "test", "forbidden-key"),
			lambda: admin.reverse_financial("collections", "x", "test", "forbidden-key"),
			lambda: admin.replace_financial("collections", "x", {}, "test", "forbidden-key"),
			lambda: admin.dsr_action("x", "note", "test", "forbidden-key"),
			lambda: admin.link_order("x", "x", "test", "forbidden-key"),
			lambda: admin.evidence_exception("x", "test", "forbidden-key"),
		]
		for call in calls:
			with self.assertRaises(frappe.PermissionError):
				call()
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			admin.bootstrap()

	def test_administrator_page_requires_no_employee(self):
		from srv_erp.www.smart_dsr_admin import get_context

		self.administrator()
		context = frappe._dict()
		get_context(context)
		self.assertTrue(context.smart_dsr_csrf_token)
		self.assertTrue(admin.bootstrap()["can_manage_users"])

	def test_sales_manager_can_manage_finance_but_not_user_roles(self):
		self.role(admin_permissions.ADMIN_ROLE)
		self.assertTrue(admin.bootstrap()["can_finance"])
		with self.assertRaises(frappe.PermissionError):
			admin.manage_user(self.user, "No", "not-user-admin")

	def test_vehicle_creator_and_manager_permissions(self):
		vehicle = frappe.get_doc("DSR Vehicle", "PB31AB1234")
		self.assertEqual(vehicle.added_by, self.user)
		self.assertEqual(vehicle.added_by_salesperson, self.employee)
		self.role("Sales Manager")
		result = admin.manage_vehicle(
			{
				"registration_number": vehicle.registration_number,
				"vehicle_type": "Car",
				"make": "Updated",
				"model": "Fixture",
				"fuel_type": "CNG",
				"insurance_number": "INS",
				"insurance_expiry": "2099-12-31",
				"puc_number": "PUC",
				"puc_expiry": "2099-12-31",
				"rc_number": "RC",
				"rc_expiry": "2099-12-31",
				"fastag_details": "FASTAG",
				"status": "Active",
			},
			"Manager correction",
			"vehicle-manager-update",
			vehicle.name,
		)
		self.assertTrue(result["audit"])
		self.assertEqual(frappe.db.get_value("DSR Vehicle", vehicle.name, "make"), "Updated")

	def test_financial_role_can_adjust_without_impersonation(self):
		duty = self.start()
		self.role(admin_permissions.FINANCE_ROLE)
		actor = frappe.session.user
		result = admin.cash_adjustment(
			duty, "Authorized Adjustment", 25, "Verified correction", "finance-adjustment"
		)
		log = frappe.get_doc("DSR Admin Audit", result["audit"])
		self.assertEqual(log.actor, actor)
		self.assertEqual(log.affected_user, self.user)
		self.assertEqual(api.summary(duty)["available_cash"], 1025)

	def test_cash_adjustment_idempotent_and_audited(self):
		duty = self.start()
		self.administrator()
		first = admin.cash_adjustment(duty, "Cash Advance", 100, "Cash handed to user", "admin-cash-test")
		second = admin.cash_adjustment(duty, "Cash Advance", 100, "Cash handed to user", "admin-cash-test")
		self.assertEqual(first, second)
		self.assertEqual(admin.details("duties", duty)["cash"], 1100)
		log = frappe.get_doc("DSR Admin Audit", first["audit"])
		self.assertEqual(log.actor, "Administrator")
		self.assertEqual(log.affected_user, self.user)
		self.assertEqual(json.loads(log.original_value)["closing_balance"], 1000)
		self.assertEqual(json.loads(log.updated_value)["closing_balance"], 1100)
		self.assertTrue(log.transaction_id)

	def test_first_opening_is_manual_once(self):
		self.administrator()
		user = frappe.get_doc(
			dict(
				doctype="User",
				email="admin-init-" + frappe.generate_hash(length=8) + "@example.invalid",
				first_name="Initial",
				send_welcome_email=0,
			)
		).insert(ignore_permissions=True)
		user.add_roles("Sales Person")
		result = admin.opening_balance(user.name, 321, "Initial verified custody", "admin-initial-test")
		self.assertEqual(admin.balance_details(user.name)["initial_opening"], 321)
		self.assertEqual(admin.opening_balance(user.name, 321, "Retry", "admin-initial-test"), result)
		with self.assertRaises(frappe.ValidationError):
			admin.opening_balance(user.name, 123, "Overwrite", "other-initial-key")

	def test_optional_employee_mapping_roles_and_access(self):
		self.administrator()
		result = admin.manage_user(
			self.user,
			"Reviewed mapping",
			"mapping-admin-test",
			employee=self.employee,
			sales_roles=["Sales User"],
			access_enabled=0,
		)
		self.assertTrue(result["audit"])
		frappe.set_user(self.user)
		with self.assertRaises(frappe.PermissionError):
			api.bootstrap()
		doc = frappe.get_doc("User", self.user)
		doc.smart_dsr_disabled = 0
		with self.assertRaises(frappe.PermissionError):
			doc.save(ignore_permissions=True)
		self.administrator()
		admin.manage_user(self.user, "Reactivate", "mapping-reactivate", access_enabled=1)
		with self.assertRaises(frappe.ValidationError):
			admin.manage_user(
				self.user, "Do not elevate", "mapping-privileged", sales_roles=["System Manager"]
			)

	def test_metadata_and_submitted_evidence_are_protected(self):
		duty = self.start()
		activity = api.dealer_arrival(duty, self.customer.name, self.gps, "admin-visit-arrival")
		self.administrator()
		api.authorize_exception(duty, "Test evidence exception", activity)
		frappe.set_user(self.user)
		api.complete_activity(activity, self.gps)
		self.administrator()
		result = admin.correct_metadata(
			"visits",
			activity,
			{"remarks": "Administrative correction"},
			"Customer clarification",
			"admin-correct-visit",
		)
		self.assertEqual(result["outcome"], "Review requested")
		self.assertFalse(frappe.db.get_value("DSR Dealer Activity", activity, "remarks"))
		admin.correct_metadata(
			"duties", duty, {"vehicle_number": "pb 31 ab 4567"}, "Correct vehicle entry", "admin-correct-duty"
		)
		self.assertEqual(frappe.db.get_value("DSR Duty Session", duty, "vehicle_number"), "PB31AB4567")
		with self.assertRaises(frappe.ValidationError):
			admin.correct_metadata("visits", activity, {"latitude": 99}, "No fake GPS", "admin-no-gps-edit")

	def test_unposted_collection_reverse_replace_preserves_ledger(self):
		duty = self.start()
		old = api.collect_payment(duty, self.customer.name, 200, "Cash", "old-cash-record")["name"]
		self.administrator()
		result = admin.replace_financial(
			"collections", old, {"amount": 150}, "Correct amount actually received", "replace-cash-test"
		)
		self.assertEqual(frappe.db.get_value("DSR Collection", old, "verification_status"), "Reversed")
		self.assertEqual(admin.details("duties", duty)["cash"], 1150)
		self.assertEqual(
			admin.replace_financial("collections", old, {"amount": 150}, "Retry", "replace-cash-test"), result
		)
		self.assertEqual(
			frappe.db.count("DSR Cash Ledger", {"duty": duty, "transaction_type": "Reversal"}), 1
		)

	def test_expense_reversal_preserves_original(self):
		duty = self.start()
		expense = api.record_expense(duty, "Parking", 50, 1, "admin-expense-old")["name"]
		self.administrator()
		result = admin.replace_financial(
			"expenses", expense, {"amount": 30}, "Correct parking cost", "replace-expense-test"
		)
		self.assertTrue(result["transaction"])
		self.assertEqual(frappe.db.get_value("DSR Expense Record", expense, "posting_status"), "Reversed")
		self.assertEqual(admin.details("duties", duty)["cash"], 970)

	def test_finalize_reopen_and_finalized_balance_protection(self):
		duty = self.start()
		api.duty_off(duty, self.gps)
		self.administrator()
		admin.dsr_action(duty, "reopen", "Resume closed draft", "admin-reopen-key")
		self.assertEqual(frappe.db.get_value("DSR Duty Session", duty, "status"), "Active")
		frappe.set_user(self.user)
		api.duty_off(duty, self.gps)
		self.administrator()
		admin.dsr_action(duty, "finalize", "Reviewed duty", "admin-finalize-key")
		self.assertEqual(frappe.db.get_value("DSR Duty Session", duty, "status"), "Finalized")
		with self.assertRaises(frappe.ValidationError):
			admin.cash_adjustment(duty, "Authorized Adjustment", 1, "Not allowed", "final-balance-edit")
		with self.assertRaises(frappe.ValidationError):
			admin.dsr_action(duty, "reopen", "Not allowed", "final-reopen-key")

	def test_audit_log_is_append_only_even_for_administrator(self):
		duty = self.start()
		self.administrator()
		result = admin.dsr_action(duty, "note", "Reviewed business record", "admin-audit-note")
		log = frappe.get_doc("DSR Admin Audit", result["audit"])
		log.reason = "Overwrite"
		with self.assertRaises(frappe.PermissionError):
			log.save(ignore_permissions=True)
		with self.assertRaises(frappe.PermissionError):
			frappe.delete_doc("DSR Admin Audit", log.name, ignore_permissions=True)

	def test_real_dashboard_pagination_search_and_reports(self):
		duty = self.start()
		api.dealer_arrival(duty, self.customer.name, self.gps, "admin-list-arrival")
		api.collect_payment(duty, self.customer.name, 100, "Cash", "admin-report-cash")
		self.administrator()
		filters = {"account": self.user, "date": str(getdate())}
		metrics = admin.overview(filters)
		self.assertEqual(metrics["on_duty"], 1)
		self.assertEqual(metrics["party_visits"], 1)
		self.assertEqual(metrics["cash_collections"], 100)
		self.assertEqual(len(admin.list_records("duties", filters)["rows"]), 1)
		self.assertEqual(len(admin.list_records("visits", filters)["rows"]), 1)
		self.assertEqual(len(admin.list_records("collections", filters)["rows"]), 1)
		self.assertEqual(admin.list_records("people", {"search": self.user}, 1, 1)["total"], 1)
		self.assertTrue(admin.list_records("employees", {"search": self.employee})["rows"])
		self.assertEqual(admin.list_records("people", {"search": self.employee})["total"], 1)
		self.assertEqual(admin.overview({"account": self.user, "all_dates": True})["cash_collections"], 100)
		for period in ("Daily", "Weekly", "Monthly", "Quarterly"):
			self.assertEqual(admin.report(period, filters)["total"], 1)
		self.assertEqual(admin.details("duties", duty)["visits"]["total"], 1)

	def test_excel_and_pdf_exports(self):
		self.start()
		self.administrator()
		filters = {"account": self.user, "date": str(getdate())}
		admin.export_report("Daily", filters, "xlsx")
		self.assertTrue(frappe.local.response.filecontent.startswith(b"PK"))
		admin.export_report("Daily", filters, "pdf")
		self.assertTrue(frappe.local.response.filecontent.startswith(b"%PDF"))
		for key in ("filename", "filecontent", "type"):
			frappe.local.response.pop(key, None)

	def test_payment_posting_and_cancellation_use_erpnext(self):
		duty = self.start()
		collection = api.collect_payment(duty, self.customer.name, 125, "Cash", "admin-post-cash")["name"]
		self.administrator()
		account = frappe.db.get_value(
			"Account", {"company": api.settings().company, "is_group": 0, "account_type": "Cash"}, "name"
		)
		if not account:
			self.skipTest("Company has no cash account.")
		frappe.db.set_single_value("DSR Settings", "cash_account", account)
		first = admin.post_payment(collection, "Post verified custody", "admin-post-payment")
		second = admin.post_payment(collection, "Retry", "admin-post-payment")
		self.assertEqual(first, second)
		pe = frappe.db.get_value("DSR Collection", collection, "payment_entry")
		self.assertEqual(frappe.db.get_value("Payment Entry", pe, "docstatus"), 1)
		admin.reverse_financial("collections", collection, "Payment entered in error", "admin-cancel-payment")
		self.assertEqual(frappe.db.get_value("Payment Entry", pe, "docstatus"), 2)
		self.assertEqual(admin.details("duties", duty)["cash"], 1000)

	def test_private_visit_photo_is_readable_to_authorized_reviewer(self):
		import base64
		from pathlib import Path

		from PIL import Image

		duty = self.start()
		visit = api.dealer_arrival(duty, self.customer.name, self.gps, "admin-photo-visit")
		challenge = api.browser_photo_challenge(visit)
		data = io.BytesIO()
		Image.new("RGB", (120, 120), (123, 45, 99)).save(data, format="JPEG")
		photo = api.browser_photo(visit, challenge, base64.b64encode(data.getvalue()).decode(), self.gps)
		path = Path(frappe.get_site_path("private", "files", photo["photo"].rsplit("/", 1)[1]))
		self.addCleanup(lambda: path.unlink(missing_ok=True))
		self.administrator()
		reviewer = frappe.get_doc(
			dict(
				doctype="User",
				email="reviewer-" + frappe.generate_hash(length=8) + "@example.invalid",
				first_name="Reviewer",
				role_profile_name=self.manager_profile(),
				roles=[{"role": admin_permissions.ADMIN_ROLE}],
				send_welcome_email=0,
			)
		).insert(ignore_permissions=True)
		frappe.set_user(reviewer.name)
		self.assertEqual(admin.details("visits", visit)["photos"][0]["photo"], photo["photo"])
		evidence = frappe.get_doc("DSR Dealer Photo Evidence", {"activity": visit})
		self.assertTrue(frappe.has_permission("DSR Dealer Photo Evidence", "read", doc=evidence))
		file = frappe.get_doc("File", {"file_url": photo["photo"]})
		file.check_permission("read")

	def test_reopen_does_not_count_closed_time_as_duty(self):
		from datetime import timedelta
		from unittest.mock import patch

		from frappe.utils import get_datetime

		duty = self.start()
		api.duty_off(duty, self.gps)
		doc = frappe.get_doc("DSR Duty Session", duty)
		ended = get_datetime(doc.ended_at)
		started = get_datetime(doc.started_at)
		self.administrator()
		with (
			patch.object(admin, "now_datetime", return_value=ended + timedelta(minutes=30)),
			patch.object(api, "now_datetime", return_value=ended + timedelta(minutes=40)),
		):
			admin.dsr_action(duty, "reopen", "Resume after review", "admin-gap-reopen")
			doc.reload()
			self.assertAlmostEqual(api.closed_gap_seconds(duty), 1800, places=2)
			self.assertAlmostEqual(api.duty_seconds(doc), (ended - started).total_seconds() + 600, places=2)

	def test_cash_report_respects_as_of_date(self):
		from datetime import timedelta

		duty = self.start()
		self.administrator()
		admin.cash_adjustment(duty, "Cash Advance", 50, "Received today", "asof-cash-advance")
		yesterday = str(getdate() - timedelta(days=1))
		historical = admin.report(
			"Cash Balances", {"account": self.user, "from_date": yesterday, "to_date": yesterday}
		)
		self.assertIsNone(historical["rows"][0]["closing_balance"])
		current = admin.report("Cash Balances", {"account": self.user, "date": str(getdate())})
		self.assertEqual(current["rows"][0]["closing_balance"], 1050)

	def test_employee_link_has_specific_audit_record(self):
		self.administrator()
		frappe.db.set_value("Employee", self.employee, "user_id", None)
		admin.manage_user(
			self.user, "Verified person and User", "employee-specific-audit", employee=self.employee
		)
		log = frappe.get_doc(
			"DSR Admin Audit",
			{"record_type": "Employee", "record_id": self.employee, "action": "Link Employee"},
		)
		self.assertEqual(log.affected_user, self.user)
		self.assertFalse(json.loads(log.original_value)["user_id"])
		self.assertEqual(json.loads(log.updated_value)["user_id"], self.user)

	def test_explicit_evidence_exceptions_are_audited(self):
		duty = self.start()
		visit = api.dealer_arrival(duty, self.customer.name, self.gps, "exception-admin-visit")
		self.administrator()
		result = admin.evidence_exception(
			duty, "Camera unavailable; reviewed on site", "admin-photo-exception", activity=visit
		)
		self.assertTrue(result["audit"])
		self.assertTrue(frappe.db.get_value("DSR Dealer Activity", visit, "photo_exception"))
		admin.evidence_exception(duty, "Ending GPS unavailable; supervisor confirmed", "admin-gps-exception")
		frappe.set_user(self.user)
		api.complete_activity(visit, self.gps)
		self.assertEqual(api.end_workday(duty, None)["duty"]["status"], "Finalized")
