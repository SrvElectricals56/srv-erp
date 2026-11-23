"""Panel datasets must stay within the selected User Role Profiles."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import admin


class TestPanelProfileScope(unittest.TestCase):
	def test_user_scope_uses_profile_not_roles(self):
		with patch.object(frappe, "get_all", return_value=["sales-user"]) as query:
			self.assertEqual(admin.visible_accounts(), ["sales-user"])
			self.assertEqual(
				query.call_args.kwargs["filters"]["role_profile_name"],
				["in", ("Sales", "Sales Manager", "Administrator")],
			)

	def test_every_owned_dataset_is_scoped(self):
		for dataset in admin.TABLES:
			if dataset in ("outstanding", "vehicles"):
				continue
			with (
				self.subTest(dataset=dataset),
				patch.object(admin, "visible_accounts", return_value=["allowed"]),
			):
				where = admin.conditions(dataset, {"all_dates": True})
				field = (
					"affected_user"
					if dataset == "audit"
					else "owner"
					if dataset == "dsrs"
					else "added_by"
					if dataset == "vehicles"
					else "account"
				)
				self.assertEqual(where[field], ["in", ["allowed"]])

	def test_empty_scope_cannot_expand_to_everyone(self):
		with patch.object(admin, "visible_accounts", return_value=[]):
			where = admin.conditions("duties", {"all_dates": True, "account": "excluded"})
			self.assertEqual(where["account"], ["in", ["__no_matching_dsr_user__"]])

	def test_customer_filter_cannot_override_outstanding_scope(self):
		with (
			patch.object(admin, "visible_accounts", return_value=["allowed"]),
			patch.object(frappe, "get_all", return_value=["allowed-customer"]),
			patch.object(admin.api, "settings", return_value=frappe._dict(company="Company")),
		):
			where = admin.conditions("outstanding", {"all_dates": True, "customer": "excluded-customer"})
			self.assertEqual(where["customer"], "__no_matching_dsr_customer__")
			where = admin.conditions("outstanding", {"all_dates": True, "customer": "allowed-customer"})
			self.assertEqual(where["customer"], "allowed-customer")

	def test_vehicle_list_includes_all_creators_and_dates(self):
		with patch.object(
			admin, "visible_accounts", side_effect=AssertionError("Fleet must not be profile scoped")
		):
			self.assertEqual(admin.conditions("vehicles", {}), {})
			self.assertEqual(
				admin.conditions("vehicles", {"account": "creator", "status": "Inactive"}),
				{"allocated_to": "creator", "status": "Inactive"},
			)

	def test_vehicle_edit_is_not_blocked_by_creator_profile(self):
		from unittest.mock import Mock

		row = frappe._dict(added_by="Administrator")
		with (
			patch.object(frappe, "get_doc", return_value=row),
			patch.object(frappe, "db", Mock()),
			patch.object(
				admin,
				"require_visible_account",
				side_effect=AssertionError("Fleet edit must not be profile scoped"),
			),
		):
			self.assertEqual(admin.locked_record("DSR Vehicle", "test-vehicle"), row)
