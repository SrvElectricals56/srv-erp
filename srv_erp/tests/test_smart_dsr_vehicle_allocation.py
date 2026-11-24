"""Vehicle visibility, self-allocation and assignment isolation."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin, api


class TestVehicleAllocation(unittest.TestCase):
	def setUp(self):
		for stub in (
			patch.object(api, "now_datetime", return_value="2026-11-17 10:00:00"),
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict(in_test=False))),
			patch.object(
				frappe,
				"throw",
				side_effect=lambda message, *args, **kwargs: (_ for _ in ()).throw(
					frappe.ValidationError(message)
				),
			),
		):
			stub.start()
			self.addCleanup(stub.stop)

	def test_only_own_active_vehicle_is_visible(self):
		with (
			patch.object(api, "account_for", return_value="user"),
			patch.object(frappe, "get_all", return_value=[]) as query,
		):
			self.assertEqual(api.available_vehicles(), [])
			self.assertEqual(query.call_args.kwargs["filters"], {"status": "Active", "allocated_to": "user"})

	def test_added_vehicle_cannot_be_assigned_to_another_user(self):
		with (
			patch.object(api, "identity", return_value="user"),
			patch.object(api, "prepare_vehicle_allocation") as allocate,
			patch.object(api, "vehicle_employee", return_value=None),
			patch.object(
				api, "insert", return_value=frappe._dict(name="PB31AB1234", registration_number="PB31AB1234")
			) as insert,
			patch.object(frappe, "db", Mock()) as db,
		):
			db.exists.return_value = False
			api.add_vehicle(
				dict(
					registration_number="PB31AB1234",
					fuel_type="CNG",
					allocated_to="other",
					insurance_available=1,
					puc_available=1,
					rc_available=1,
					fastag_available=1,
				)
			)
			allocate.assert_called_once_with("user")
			self.assertEqual(insert.call_args.kwargs["allocated_to"], "user")
			self.assertEqual(insert.call_args.kwargs["added_by"], "user")

	def test_replacement_clears_old_allocation(self):
		previous = frappe._dict(allocated_to="user")
		with (
			patch.object(api, "account_for"),
			patch.object(frappe, "get_roles", return_value=["Sales Person"]),
			patch.object(frappe, "get_all", return_value=["old"]),
			patch.object(frappe, "get_doc", return_value=previous),
			patch.object(api, "save") as save,
			patch.object(frappe, "db", Mock()) as db,
		):
			db.exists.return_value = False
			api.prepare_vehicle_allocation("user", "new")
			self.assertIsNone(previous.allocated_to)
			save.assert_called_once_with(previous)

	def test_vehicle_on_another_users_active_duty_cannot_be_reassigned(self):
		with (
			patch.object(api, "account_for"),
			patch.object(frappe, "get_roles", return_value=["Sales Person"]),
			patch.object(frappe, "get_all") as query,
			patch.object(frappe, "db", Mock()) as db,
		):
			db.exists.return_value = True
			with self.assertRaisesRegex(frappe.ValidationError, "in use"):
				api.prepare_vehicle_allocation("user", "PB31AB1234")
			query.assert_not_called()

	def test_admin_must_choose_salesperson(self):
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "reason", return_value="reason"),
			patch.object(admin, "prior", return_value=None),
			patch.object(api, "prepare_vehicle_allocation") as allocate,
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Select the salesperson"):
				admin.manage_vehicle(
					dict(
						registration_number="PB31AB1234",
						fuel_type="CNG",
						insurance_available=1,
						puc_available=1,
						rc_available=1,
						fastag_available=1,
					)
				)
			allocate.assert_not_called()

	def test_duty_start_rejects_another_users_vehicle(self):
		with (
			patch.object(api, "identity", return_value="user"),
			patch.object(api, "bootstrap"),
			patch.object(api, "settings"),
			patch.object(frappe, "db", Mock()) as db,
		):
			db.get_value.return_value = frappe._dict(allocated_to="other")
			with self.assertRaisesRegex(frappe.ValidationError, "not allocated"):
				api.duty_on("PB31AB1234")

	def test_all_four_documents_required_before_add(self):
		for missing in ("insurance", "puc", "rc", "fastag"):
			values = dict(
				registration_number="PB31AB1234",
				fuel_type="CNG",
				insurance_available="1",
				puc_available="1",
				rc_available="1",
				fastag_available="1",
			)
			values[missing + "_available"] = "0"
			with (
				self.subTest(missing=missing),
				patch.object(api, "identity", return_value="user"),
				patch.object(api, "insert") as insert,
			):
				with self.assertRaisesRegex(frappe.ValidationError, "Tick Insurance, PUC, RC and FASTag"):
					api.add_vehicle(values)
				insert.assert_not_called()
