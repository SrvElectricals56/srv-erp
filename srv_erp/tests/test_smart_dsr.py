"""Regression tests with transaction-scoped fixtures; no production records modified."""

import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import Mock, patch

import frappe
from frappe.utils import getdate, now_datetime

from srv_erp.smart_dsr import api
from srv_erp.smart_dsr.policy import balance, coordinates, geofence, money, positive_quantity, segment


class TestPolicy(unittest.TestCase):
	def test_order_copies_the_required_brand_from_its_items(self):
		order = frappe._dict(
			meta=Mock(get_field=Mock(return_value=frappe._dict(reqd=1)), has_field=Mock(return_value=False)),
			append=Mock(return_value=Mock()),
			set_missing_values=Mock(),
			calculate_taxes_and_totals=Mock(),
		)
		item = frappe._dict(
			name="ITEM-0001", brand="SRV", is_sales_item=1, stock_uom="Nos", check_permission=Mock()
		)
		with (
			patch.object(frappe, "new_doc", return_value=order),
			patch.object(frappe, "get_doc", return_value=item),
			patch.object(api, "settings", return_value=frappe._dict(company="Test Company")),
			patch.object(api, "getdate", return_value=date(2026, 11, 23)),
			patch("srv_erp.selling.sales_order_uom.get_sales_order_uom", return_value=("Nos", None)),
		):
			api.build_order("CUSTOMER", [{"item_code": item.name, "qty": 1}], "2026-11-23")
		self.assertEqual(order.brand_filter, "SRV")
		order.set_missing_values.assert_called_once()

	def test_fractional_order_quantities_are_not_currency_rounded(self):
		self.assertEqual(positive_quantity("0.005"), 0.005)
		for value in (0, -1, "NaN", "Infinity"):
			with self.assertRaises(ValueError):
				positive_quantity(value)

	def test_decimal_reconciliation(self):
		self.assertEqual(balance("100.10", ["20.20", "-10.30"]), money("110.00"))

	def test_nonfinite_amount(self):
		for value in ("NaN", "Infinity"):
			with self.assertRaises(ValueError):
				money(value)

	def test_invalid_coordinates(self):
		for values in [(91, 0, 5), (0, 181, 5), (0, 0, -1), (float("nan"), 0, 1)]:
			with self.assertRaises(ValueError):
				coordinates(*values)

	def test_implausible_distance(self):
		a = dict(latitude=28.0, longitude=77.0, accuracy=5.0)
		self.assertEqual(segment(a, dict(a, latitude=29.0), 10)[1], "Implausible speed")

	def test_unverified_gap(self):
		a = dict(latitude=28.0, longitude=77.0, accuracy=5.0)
		self.assertEqual(segment(a, a, 600)[1], "Unverified interval")

	def test_stationary_noise(self):
		a = dict(latitude=28.0, longitude=77.0, accuracy=20.0)
		self.assertEqual(segment(a, dict(a, latitude=28.00001), 30)[0], 0)

	def test_accurate_distance(self):
		a = dict(latitude=28.0, longitude=77.0, accuracy=5.0)
		self.assertAlmostEqual(segment(a, dict(a, latitude=28.001), 30)[0], 0.111195, places=5)

	def test_geofence_uncertainty(self):
		a = dict(latitude=28.0, longitude=77.0, accuracy=5.0)
		self.assertEqual(geofence(a, None), "Unknown")
		self.assertEqual(geofence(a, dict(a, accuracy=100)), "Unknown")
		self.assertEqual(geofence(a, a), "Inside")
		self.assertEqual(geofence(a, dict(a, latitude=28.01)), "Outside")

	def test_retired_ui_absent(self):
		source = (Path(__file__).parents[1] / "public/smart_dsr/app.js").read_text()
		for text in ("Today's Journey", "New Dealer", "Paid vs Unpaid", "Break Alerts"):
			self.assertNotIn(text, source)
		self.assertNotIn('type="file" name="photo"', source)
		self.assertIn("captureShop", source)


class TestSmartDSR(unittest.TestCase):
	def setUp(self):
		frappe.set_user("Administrator")
		frappe.db.savepoint("smart_dsr_test")
		self.addCleanup(self.cleanup)
		self.user = "dsr-test-" + frappe.generate_hash(length=8) + "@example.invalid"
		company = frappe.get_all("Company", pluck="name", limit=1)[0]
		frappe.db.set_single_value("DSR Settings", "company", company)
		frappe.get_doc(
			dict(
				doctype="User",
				email=self.user,
				first_name="DSR Test",
				send_welcome_email=0,
				roles=[{"role": "Sales User"}, {"role": "Sales Person"}],
			)
		).insert(ignore_permissions=True)
		emp = frappe.get_doc(
			dict(
				doctype="Employee",
				first_name="DSR Test",
				employee_name="DSR Test",
				gender="Male",
				date_of_birth="1990-01-01",
				date_of_joining="2020-01-01",
				status="Active",
				company=company,
				user_id=self.user,
			)
		)
		emp.insert(ignore_permissions=True, ignore_mandatory=True)
		self.employee = emp.name
		self.sales = frappe.get_doc(
			dict(
				doctype="Sales Person",
				sales_person_name="DSR Test " + frappe.generate_hash(length=8),
				employee=emp.name,
				sales_user=self.user,
				enabled=1,
			)
		).insert(ignore_permissions=True)
		self.customer = frappe.get_doc(
			dict(
				doctype="Customer",
				owner=self.user,
				customer_name="DSR Test " + frappe.generate_hash(length=8),
				customer_type="Company",
				sales_person=self.sales.name,
				sales_team=[{"sales_person": self.sales.name, "allocated_percentage": 100}],
				customer_group=frappe.get_all(
					"Customer Group", filters={"is_group": 0}, pluck="name", limit=1
				)[0],
				territory=frappe.get_all("Territory", filters={"is_group": 0}, pluck="name", limit=1)[0],
			)
		).insert(ignore_permissions=True)
		self.customer.db_set("owner", self.user, update_modified=False)
		api.initialize_balance(self.user, 1000, "initial-cash-key", "Automated rollback test")
		frappe.set_user(self.user)
		self.gps = dict(latitude=28.0, longitude=77.0, accuracy=5.0)
		api.add_vehicle(
			{
				"registration_number": "PB31AB1234",
				"vehicle_type": "Car",
				"make": "Test",
				"model": "Fixture",
				"fuel_type": "CNG",
				"insurance_number": "INS-TEST",
				"insurance_expiry": "2099-12-31",
				"puc_number": "PUC-TEST",
				"puc_expiry": "2099-12-31",
				"rc_number": "RC-TEST",
				"rc_expiry": "2099-12-31",
				"fastag_details": "FASTAG-TEST",
			}
		)

	def cleanup(self):
		frappe.set_user("Administrator")
		frappe.db.rollback(save_point="smart_dsr_test")
		frappe.clear_cache(user=self.user)

	def start(self):
		return api.duty_on(
			"PB31AB1234",
			"CNG",
			"Current Location",
			self.gps,
			"start-duty-key",
			documents=dict(insurance=True, puc=True, rc=True, fastag=True),
		)["duty"]["name"]

	def test_administrator_initialization(self):
		name = self.start()
		self.assertNotIn("opening_balance", api.summary(name)["duty"])
		self.assertEqual(frappe.db.get_value("DSR Duty Session", name, "opening_balance"), 1000)

	def test_salesperson_cannot_initialize(self):
		with self.assertRaises(frappe.PermissionError):
			api.initialize_balance(self.user, 99999, "attack-key", "attack")

	def test_duty_on_idempotency(self):
		name = self.start()
		self.assertEqual(name, self.start())
		self.assertEqual(api.summary(name)["duty"]["status"], "Active")

	def test_direct_opening_edit_rejected(self):
		doc = frappe.get_doc("DSR Duty Session", self.start())
		doc.opening_balance = 99999
		with self.assertRaises(frappe.PermissionError):
			doc.save(ignore_permissions=True)

	def test_cash_collection_once(self):
		name = self.start()
		first = api.collect_payment(name, self.customer.name, 200, "Cash", "cash-test-key")
		second = api.collect_payment(name, self.customer.name, 200, "Cash", "cash-test-key")
		self.assertEqual(first["name"], second["name"])
		self.assertEqual(api.summary(name)["available_cash"], 1200)
		self.assertNotIn("opening_balance", api.summary(name)["duty"])

	def test_upi_collection_increases_balance(self):
		name = self.start()
		api.collect_payment(
			name, self.customer.name, 200, "UPI", "noncash-test", transaction_reference="txn123"
		)
		self.assertEqual(api.summary(name)["available_cash"], 1200)
		self.assertEqual(api.summary(name)["collection_total"], 200)

	def test_cash_expense_once(self):
		name = self.start()
		for _ in range(2):
			api.record_expense(name, "Parking", 100, 1, "expense-test")
		self.assertEqual(api.summary(name)["available_cash"], 900)

	def test_non_cash_expense(self):
		name = self.start()
		api.record_expense(name, "Toll", 100, 0, "noncash-expense")
		self.assertEqual(api.summary(name)["available_cash"], 1000)

	def test_duty_off_and_finalize(self):
		name = self.start()
		self.assertEqual(api.duty_off(name, self.gps)["duty"]["status"], "Closed")
		final = api.finalize(name)
		self.assertEqual(final["duty"]["status"], "Finalized")
		self.assertEqual(frappe.db.get_value("DSR", final["duty"]["dsr"], "docstatus"), 1)

	def test_photo_and_open_activity_validation(self):
		name = self.start()
		activity = api.dealer_arrival(name, self.customer.name, self.gps, "arrival-test")
		with self.assertRaises(frappe.ValidationError):
			api.complete_activity(activity, self.gps)
		with self.assertRaises(frappe.ValidationError):
			api.duty_off(name, self.gps)

	def test_authorized_photo_exception(self):
		name = self.start()
		activity = api.dealer_arrival(name, self.customer.name, self.gps, "arrival-test")
		frappe.set_user("Administrator")
		api.authorize_exception(name, "Verified camera hardware failure", activity)
		frappe.set_user(self.user)
		api.complete_activity(activity, self.gps)
		self.assertEqual(api.summary(name)["activities"][0]["status"], "Completed")

	def test_gps_interrupt_resume_and_dedup(self):
		name = self.start()
		api.gps_interruption(name, "Permission revoked")
		point = dict(self.gps, id="sample-test-key", captured_at=str(now_datetime()))
		api.gps_batch(name, [point])
		api.gps_batch(name, [point])
		s = api.summary(name)
		self.assertEqual(s["duty"]["gps_status"], "Tracking")
		self.assertEqual(
			[e["event_type"] for e in s["events"] if e["event_type"] in ("Interrupted", "Resumed")],
			["Interrupted", "Resumed"],
		)
		self.assertEqual(frappe.db.count("DSR GPS Point", {"point_key": api.key(point["id"], self.user)}), 1)

	def test_meal_duplicate_prevention(self):
		# Historical duties retain their original break-based allowance rules.
		frappe.db.set_single_value(
			"DSR Settings", "automatic_meal_expenses_from", getdate() + timedelta(days=1)
		)
		name = self.start()
		for n in (1, 2):
			break_id = api.start_break(name, "Lunch", "lunch-test-" + str(n))
			row = frappe.get_doc("DSR Break", break_id)
			row.started_at = now_datetime().replace(hour=12, minute=0, second=0)
			api.save(row)
			with patch.object(
				api, "now_datetime", return_value=now_datetime().replace(hour=12, minute=30, second=0)
			):
				api.end_break(break_id)
		self.assertEqual(api.summary(name)["meal_allowance"], 150)

	def test_night_geofence(self):
		name = self.start()
		api.night_stay_on(name, self.gps, "Test stay", "stay-test-key")
		api.gps_batch(
			name,
			[
				dict(
					latitude=28.01,
					longitude=77.0,
					accuracy=5.0,
					id="outside-test",
					captured_at=str(now_datetime()),
				)
			],
		)
		self.assertIn("Geofence Outside", [e["event_type"] for e in api.summary(name)["events"]])

	def test_account_authorization(self):
		name = self.start()
		with patch.object(api, "identity", return_value="other-user@example.invalid"):
			with self.assertRaises(frappe.PermissionError):
				api.summary(name)

	def test_outstanding_fetch(self):
		dues = api.outstanding(self.customer.name)
		self.assertEqual(dues["pending"], 0)
		self.assertEqual(dues["invoices"], [])

	def test_legacy_anchor_protected(self):
		report = frappe.get_doc("DSR", api.summary(self.start())["duty"]["dsr"])
		report.opening_balance = 99999
		with self.assertRaises(frappe.PermissionError):
			report.save(ignore_permissions=True)

	def test_configured_fuel_rate(self):
		frappe.set_user("Administrator")
		frappe.db.set_single_value("DSR Settings", "cng_rate", 7)
		frappe.set_user(self.user)
		name = self.start()
		api.insert(
			"DSR GPS Point",
			account=self.user,
			duty=name,
			point_key=api.key("fuel-test-point", self.user),
			**self.gps,
			captured_at=now_datetime(),
			received_at=now_datetime(),
			verified=1,
			distance_km=10,
		)
		self.assertEqual(api.duty_off(name, self.gps)["fuel_reimbursement"], 70)

	def test_previous_finalized_closing_carries(self):
		name = self.start()
		api.record_expense(name, "Parking", 100, 1, "carry-expense")
		api.duty_off(name, self.gps)
		api.finalize(name)
		with patch.object(
			api,
			"getdate",
			side_effect=lambda value=None: getdate(value) if value else getdate() + timedelta(days=1),
		):
			second = self.start()
		self.assertNotEqual(name, second)
		self.assertNotIn("opening_balance", api.summary(second)["duty"])
		self.assertEqual(frappe.db.get_value("DSR Duty Session", second, "opening_balance"), 900)

	def test_invoice_allocation_reservation(self):
		import json

		name = self.start()
		invoice = frappe._dict(
			name="TEST-INVOICE",
			customer=self.customer.name,
			company=api.settings().company,
			docstatus=1,
			currency=frappe.get_cached_value("Company", api.settings().company, "default_currency"),
			outstanding_amount=500,
			check_permission=lambda *args: None,
		)
		get_doc = frappe.get_doc

		def fetch(doctype, *args, **kwargs):
			return invoice if doctype == "Sales Invoice" else get_doc(doctype, *args, **kwargs)

		with patch.object(frappe, "get_doc", side_effect=fetch):
			result = api.collect_payment(
				name,
				self.customer.name,
				200,
				"Cash",
				"invoice-collect",
				allocations=[{"invoice": "TEST-INVOICE", "amount": 200}],
			)
			with self.assertRaises(frappe.ValidationError):
				api.collect_payment(
					name,
					self.customer.name,
					400,
					"Cash",
					"invoice-overallocate",
					allocations=[{"invoice": "TEST-INVOICE", "amount": 400}],
				)
		self.assertEqual(
			json.loads(frappe.get_doc("DSR Collection", result["name"]).allocations),
			[{"invoice": "TEST-INVOICE", "amount": 200.0}],
		)

	def test_outstanding_overdue_summary(self):
		currency = frappe.get_cached_value("Company", api.settings().company, "default_currency")
		invoice = frappe._dict(
			name="TEST-DUE",
			posting_date=getdate() - timedelta(days=40),
			due_date=getdate() - timedelta(days=10),
			outstanding_amount=500,
			currency=currency,
		)
		get_all = frappe.get_all

		def scoped(doctype, *args, **kwargs):
			return [invoice] if doctype == "Sales Invoice" else get_all(doctype, *args, **kwargs)

		with patch.object(frappe, "get_all", side_effect=scoped):
			result = api.outstanding(self.customer.name)
		self.assertEqual(result["pending"], 500)
		self.assertEqual(result["overdue"], 500)
		self.assertEqual(result["invoices"][0].days_overdue, 10)

	def test_signed_private_camera_evidence(self):
		import base64
		import hashlib
		import io

		from cryptography.hazmat.primitives import hashes, serialization
		from cryptography.hazmat.primitives.asymmetric import ec
		from PIL import Image

		name = self.start()
		activity = api.dealer_arrival(name, self.customer.name, self.gps, "photo-arrival")
		private_key = ec.generate_private_key(ec.SECP256R1())
		pem = (
			private_key.public_key()
			.public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)
			.decode()
		)
		frappe.set_user("Administrator")
		device = api.enroll_device(self.user, "Test camera", pem)
		frappe.set_user(self.user)
		challenge = api.photo_challenge(activity, device)["challenge"]
		data = io.BytesIO()
		Image.new("RGB", (16, 16), "white").save(data, format="JPEG")
		raw = data.getvalue()
		stamp = str(now_datetime())
		message = "\n".join(
			(
				challenge,
				activity,
				stamp,
				"28.00000000",
				"77.00000000",
				"5.000",
				hashlib.sha256(raw).hexdigest(),
			)
		)
		signature = base64.b64encode(private_key.sign(message.encode(), ec.ECDSA(hashes.SHA256()))).decode()
		result = api.submit_photo(
			activity, device, challenge, stamp, self.gps, base64.b64encode(raw).decode(), signature
		)
		path = Path(frappe.get_site_path("private", "files", result["photo"].rsplit("/", 1)[1]))
		self.addCleanup(lambda: path.unlink(missing_ok=True))
		self.assertTrue(result["photo"].startswith("/private/files/"))
		file = frappe.get_doc("File", {"file_url": result["photo"]})
		self.assertEqual(file.is_private, 1)
		self.assertEqual(file.attached_to_name, result["name"])
		with self.assertRaises(frappe.PermissionError):
			frappe.delete_doc("File", file.name, ignore_permissions=True)
		api.complete_activity(activity, self.gps)

	def test_sustained_gps_interruption_notifies_manager(self):
		name = self.start()
		api.gps_interruption(name, "Signal lost")
		row = frappe.get_doc("DSR Duty Session", name)
		row.gps_interrupted_at = now_datetime() - timedelta(minutes=20)
		api.save(row)
		with patch.object(api, "notify") as notify:
			api.check_tracking()
			self.assertTrue(notify.called)
		self.assertEqual(frappe.db.get_value("DSR Duty Session", name, "manager_notified"), 1)

	def test_night_gps_missing_is_unknown(self):
		name = self.start()
		stay = api.night_stay_on(name, self.gps, "Test stay", "unknown-stay")
		api.duty_off(name, self.gps)
		api.finalize(name)
		api.gps_interruption(name, "GPS disabled")
		self.assertEqual(frappe.db.get_value("DSR Night Stay", stay, "state"), "Unknown")

	def test_finalized_night_does_not_accrue_fuel(self):
		name = self.start()
		api.night_stay_on(name, self.gps, "Test stay", "final-stay")
		api.duty_off(name, self.gps)
		api.finalize(name)
		api.gps_batch(name, [dict(self.gps, id="final-night-point", captured_at=str(now_datetime()))])
		self.assertEqual(api.summary(name)["fuel_reimbursement"], 0)

	def test_poor_accuracy_interrupts_verified_tracking(self):
		name = self.start()
		api.gps_batch(
			name, [dict(self.gps, accuracy=500, id="poor-accuracy-test", captured_at=str(now_datetime()))]
		)
		self.assertEqual(api.summary(name)["duty"]["gps_status"], "Interrupted")
		self.assertEqual(api.summary(name)["duty"]["verified_km"], 0)

	def test_erpnext_payment_entry_posted_exactly_once(self):
		name = self.start()
		collection = api.collect_payment(name, self.customer.name, 200, "Cash", "erp-payment-entry")
		frappe.set_user("Administrator")
		company = api.settings().company
		account = frappe.db.get_value(
			"Account", {"company": company, "is_group": 0, "account_type": "Cash"}, "name"
		)
		if not account:
			self.skipTest("Company has no cash account for ERPNext accounting integration.")
		frappe.db.set_single_value("DSR Settings", "cash_account", account)
		first = api.post_collection(collection["name"])
		second = api.post_collection(collection["name"])
		self.assertEqual(first, second)
		self.assertEqual(frappe.db.get_value("Payment Entry", first, "docstatus"), 1)
		entries = frappe.get_all(
			"GL Entry",
			filters={"voucher_type": "Payment Entry", "voucher_no": first, "is_cancelled": 0},
			fields=["debit", "credit"],
		)
		self.assertTrue(entries)
		self.assertEqual(money(sum(x.debit for x in entries)), money(sum(x.credit for x in entries)))
		frappe.set_user(self.user)
		self.assertEqual(api.summary(name)["available_cash"], 1200)

	def test_erpnext_order_prices_and_workflow(self):
		name = self.start()
		frappe.set_user("Administrator")
		from srv_erp.selling.sales_order_uom import get_sales_order_uom

		group = frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name", limit=1)[0]
		allowed, _group = get_sales_order_uom(group)
		stock_doctype = frappe.get_meta("Item").get_field("stock_uom").options
		stock_uom = (
			allowed
			if allowed and frappe.db.exists(stock_doctype, allowed)
			else frappe.get_all(stock_doctype, pluck="name", limit=1)[0]
		)
		item = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": "DSR-TEST-" + frappe.generate_hash(length=8),
				"item_name": "DSR integration test",
				"item_group": group,
				"stock_uom": stock_uom,
				"is_stock_item": 0,
				"is_sales_item": 1,
				"is_purchase_item": 0,
			}
		).insert(ignore_permissions=True)
		item.db_set("owner", self.user, update_modified=False)
		price_list = (
			frappe.db.get_single_value("Selling Settings", "selling_price_list") or "Standard Selling"
		)
		currency = frappe.get_cached_value("Company", api.settings().company, "default_currency")
		frappe.get_doc(
			{
				"doctype": "Item Price",
				"item_code": item.name,
				"price_list": price_list,
				"price_list_rate": 100,
				"currency": currency,
			}
		).insert(ignore_permissions=True)
		frappe.set_user(self.user)
		items = [{"item_code": item.name, "qty": 2}]
		preview = api.preview_order(name, self.customer.name, items, str(getdate() + timedelta(days=1)))
		self.assertEqual(preview["subtotal"], 200, repr(preview))
		first = api.create_order(
			name, self.customer.name, items, str(getdate() + timedelta(days=1)), "erp-order-request"
		)
		second = api.create_order(
			name, self.customer.name, items, str(getdate() + timedelta(days=1)), "erp-order-request"
		)
		self.assertEqual(first, second)
		self.assertEqual(frappe.db.get_value("Sales Order", first, "total"), 200)

	def test_daily_weekly_monthly_quarterly_reports(self):
		name = self.start()
		api.collect_payment(name, self.customer.name, 200, "Cash", "report-payment")
		for period in ("Daily", "Weekly", "Monthly", "Quarterly"):
			result = api.reports(period)
			self.assertEqual(len(result["days"]), 1)
			self.assertEqual(result["days"][0]["collections"], 200)
			self.assertEqual(result["days"][0]["closing_balance"], 1200)

	def test_offline_points_before_stay_do_not_trigger_geofence(self):
		name = self.start()
		started = frappe.get_doc("DSR Duty Session", name).started_at
		api.night_stay_on(name, self.gps, "Test stay", "late-sync-stay")
		api.gps_batch(
			name,
			[
				dict(
					latitude=28.01,
					longitude=77.0,
					accuracy=5.0,
					id="before-stay-point",
					captured_at=str(started),
				)
			],
		)
		self.assertNotIn("Geofence Outside", [e["event_type"] for e in api.summary(name)["events"]])

	def test_enabled_user_requires_sales_role(self):
		name = self.start()
		with patch.object(frappe, "get_roles", return_value=["Employee"]):
			with self.assertRaises(frappe.PermissionError):
				api.summary(name)

	def test_fuel_cash_disbursement_does_not_duplicate_expense(self):
		name = self.start()
		doc = frappe.get_doc("DSR Duty Session", name)
		doc.verified_km = 10
		api.save(doc)
		for _ in range(2):
			api.record_expense(name, "Fuel Reimbursement", 40, 1, "fuel-disbursement")
		result = api.summary(name)
		self.assertEqual(result["available_cash"], 960)
		self.assertEqual(result["expense_total"], 40)
		self.assertEqual(api.reports()["days"][0]["expenses"], 40)
		with self.assertRaises(frappe.ValidationError):
			api.record_expense(name, "Fuel Reimbursement", 1, 1, "fuel-overpayment")

	def test_administrator_expense_reversal_restores_cash(self):
		name = self.start()
		expense = api.record_expense(name, "Parking", 100, 1, "reversal-expense")
		movement = frappe.db.get_value(
			"DSR Cash Ledger", {"source_type": "DSR Expense Record", "source_name": expense["name"]}, "name"
		)
		frappe.set_user("Administrator")
		api.cash_movement(name, "Reversal", 0, "reversal-test", "Duplicate receipt corrected", movement)
		frappe.set_user(self.user)
		self.assertEqual(api.summary(name)["available_cash"], 1000)
		self.assertEqual(api.summary(name)["expense_total"], 0)
