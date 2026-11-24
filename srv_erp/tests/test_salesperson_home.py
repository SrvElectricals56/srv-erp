"""Home routing must never alter the shared workspace or another role's landing page."""

import unittest
from unittest.mock import Mock, patch

import frappe
from werkzeug.wrappers import Response

from srv_erp.smart_dsr import home


class TestSalespersonHome(unittest.TestCase):
	def test_role_isolation(self):
		for user, roles, expected in [
			("Guest", ["Sales Person"], False),
			("Administrator", ["Sales Person"], False),
			("sales@example.com", ["Sales Person"], False),
			("manager@example.com", ["Sales Manager"], False),
			("accounts@example.com", ["Accounts User"], False),
		]:
			with (
				self.subTest(user=user),
				patch.object(frappe, "get_roles", return_value=roles),
				patch.object(
					frappe, "db", Mock(get_value=Mock(return_value=None), exists=Mock(return_value=False))
				),
			):
				self.assertEqual(home.enabled(user), expected)

	def test_only_exact_sales_profile_regardless_of_mapping(self):
		for profile, mapped, expected in [
			("Sales", False, True),
			("Sales", True, True),
			(None, True, False),
			("", True, False),
			("sales", True, False),
			("Sales Manager", True, False),
			("Administrator", True, False),
			("Stock Manager", True, False),
		]:
			with (
				self.subTest(profile=profile, mapped=mapped),
				patch.object(
					frappe, "get_roles", return_value=["Sales Person", "DRS Salesman", "Sales User"]
				),
				patch.object(
					frappe, "db", Mock(get_value=Mock(return_value=profile), exists=Mock(return_value=mapped))
				),
			):
				self.assertEqual(home.enabled("test@example.com"), expected)

	def test_boot_is_session_only_and_idempotent(self):
		boot = frappe._dict(
			user=frappe._dict(default_workspace="Selling"), allowed_workspaces=[], home_page="Workspaces"
		)
		with patch.object(home, "enabled", return_value=True):
			home.boot_session(boot)
			home.boot_session(boot)
		self.assertEqual(boot.user.default_workspace.name, "Home")
		self.assertEqual(len(boot.allowed_workspaces), 1)
		other = frappe._dict(user=frappe._dict(default_workspace="Accounts"), home_page="Workspaces")
		with patch.object(home, "enabled", return_value=False):
			home.boot_session(other)
		self.assertEqual(other.user.default_workspace, "Accounts")

	def test_login_response_is_scoped(self):
		for enabled in (True, False):
			response = Response(
				'{"home_page":"/app/selling","message":"Logged In"}', mimetype="application/json"
			)
			with (
				patch.object(home, "enabled", return_value=enabled),
				patch.object(frappe, "local", frappe._dict(response={"message": "Logged In"})),
			):
				home.login_home(response)
			self.assertEqual(response.get_json()["home_page"], "/app/home" if enabled else "/app/selling")

	def test_top_items_only_aggregates_readable_orders(self):
		customer = Mock()
		order = Mock()
		order.items = [
			frappe._dict(item_code="A", item_name="Item A", stock_uom="Nos", stock_qty=2),
			frappe._dict(item_code="A", item_name="Item A", stock_uom="Nos", stock_qty=3),
		]
		with (
			patch.object(home, "enabled", return_value=True),
			patch.object(frappe, "get_doc", side_effect=[customer, order]),
			patch.object(frappe, "get_list", return_value=["SO-1"]) as listing,
		):
			rows = home.dealer_top_items.__wrapped__("Dealer")
		self.assertEqual(rows[0]["qty"], 5)
		customer.check_permission.assert_called_once_with("read")
		order.check_permission.assert_called_once_with("read")
		self.assertEqual(listing.call_args.kwargs["filters"], {"customer": "Dealer", "docstatus": 1})

	def test_notifications_are_scoped_to_authenticated_account_across_duties(self):
		with (
			patch.object(home, "enabled", return_value=True),
			patch("srv_erp.smart_dsr.security.account_for", return_value="sales@example.com"),
			patch.object(frappe, "get_all", return_value=[]) as listing,
		):
			home.notifications.__wrapped__(start=-100)
		self.assertEqual(listing.call_args.kwargs["filters"], {"account": "sales@example.com"})
		self.assertEqual(listing.call_args.kwargs["limit_start"], 0)
		self.assertEqual(listing.call_args.kwargs["limit_page_length"], 100)

	def test_other_profiles_cannot_read_sales_home_notifications(self):
		with (
			patch.object(home, "enabled", return_value=False),
			patch.object(frappe, "throw", side_effect=frappe.PermissionError),
			patch.object(frappe, "get_all") as listing,
		):
			with self.assertRaises(frappe.PermissionError):
				home.notifications.__wrapped__()
		listing.assert_not_called()
