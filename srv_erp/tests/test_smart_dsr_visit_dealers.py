import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import admin


class TestVisitDealerOptions(unittest.TestCase):
	def test_dealers_are_scoped_to_selected_salesperson_visits(self):
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "visible_accounts", return_value=["sales@test"]) as visible,
			patch.object(
				admin.frappe,
				"get_all",
				side_effect=[["dealer-1"], [frappe._dict(name="dealer-1", customer_name="Dealer One")]],
			) as query,
		):
			result = admin.visit_dealer_options.__wrapped__("sales@test")
		visible.assert_called_once_with("sales@test")
		self.assertEqual(query.call_args_list[0].kwargs["filters"], {"account": ["in", ["sales@test"]]})
		self.assertEqual(query.call_args_list[1].kwargs["filters"], {"name": ["in", ["dealer-1"]]})
		self.assertEqual(result[0].customer_name, "Dealer One")

	def test_out_of_scope_account_has_no_options(self):
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "visible_accounts", return_value=[]),
			patch.object(admin.frappe, "get_all") as query,
		):
			self.assertEqual(admin.visit_dealer_options.__wrapped__("hidden@test"), [])
			query.assert_not_called()

	def test_admin_permission_required(self):
		with patch.object(admin, "require_admin", side_effect=frappe.PermissionError):
			with self.assertRaises(frappe.PermissionError):
				admin.visit_dealer_options.__wrapped__()

	def test_collections_picker_includes_dealers_from_collections(self):
		with (
			patch.object(admin, "require_admin"),
			patch.object(admin, "visible_accounts", return_value=["sales@test"]),
			patch.object(
				admin.frappe,
				"get_all",
				side_effect=[["dealer-1"], [frappe._dict(name="dealer-1", customer_name="Dealer One")]],
			) as query,
		):
			admin.visit_dealer_options.__wrapped__("sales@test", dataset="collections")
		self.assertEqual(query.call_args_list[0].args[0], "DSR Collection")
