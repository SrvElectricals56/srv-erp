"""Access checks without business fixtures or database writes."""

import unittest
from unittest.mock import Mock, patch

import frappe

from srv_erp.smart_dsr import admin_permissions, security
from srv_erp.www import smart_dsr_admin
from srv_erp.www import smart_dsr_content as smart_dsr


class TestSmartDSRAccess(unittest.TestCase):
	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_page_and_api_access_matrix(self):
		for user, profile, roles, enabled, disabled, admin_allowed, sales_allowed in (
			("Guest", None, [], True, False, False, False),
			("Administrator", None, [], True, False, True, True),
			("test@example.invalid", "Sales", [], True, False, False, False),
			("test@example.invalid", "Sales", ["System Manager"], True, False, False, False),
			("test@example.invalid", "Sales", ["Accounts Manager"], True, False, False, False),
			("test@example.invalid", "Sales", ["Sales Person"], True, False, False, True),
			("test@example.invalid", "Sales", ["Sales Manager"], True, False, False, True),
			("test@example.invalid", "Sales Manager", [], True, False, True, True),
			("test@example.invalid", "Administrator", [], True, False, True, True),
			("test@example.invalid", "System Manager", ["Sales Manager"], True, False, False, True),
			("test@example.invalid", None, ["Sales Manager"], True, False, False, True),
			("test@example.invalid", "Sales Manager", [], False, False, False, False),
			("test@example.invalid", "Administrator", [], True, True, False, False),
			("test@example.invalid", "Sales", ["Sales Manager"], False, False, False, False),
			("test@example.invalid", "Sales", ["Sales Manager"], True, True, False, False),
		):
			with self.subTest(user=user, roles=roles, enabled=enabled, disabled=disabled):
				db = Mock()
				db.has_column.return_value = True
				db.get_value.side_effect = lambda dt, name, field: {
					"enabled": enabled,
					"smart_dsr_disabled": disabled,
					"role_profile_name": profile,
					"desk_theme": "Light",
				}[field]
				with (
					patch.object(frappe, "session", frappe._dict(user=user)),
					patch.object(frappe, "local", frappe._dict(flags=frappe._dict())),
					patch.object(frappe, "form_dict", {"desk": "1"}),
					patch.object(frappe, "db", db),
					patch.object(frappe, "get_roles", return_value=roles),
					patch.object(frappe, "throw", side_effect=self.throw),
					patch("frappe.sessions.get_csrf_token", return_value="token"),
				):
					self.assertEqual(admin_permissions.is_admin(), admin_allowed)
					self.assertEqual(
						admin_permissions.audit_permission(permission_type="read"), admin_allowed
					)
					if admin_allowed:
						admin_permissions.require_finance()
					else:
						with self.assertRaises(frappe.PermissionError):
							admin_permissions.require_finance()
					for controller, allowed in ((smart_dsr_admin, admin_allowed), (smart_dsr, sales_allowed)):
						if allowed:
							controller.get_context(frappe._dict())
						else:
							error = (
								frappe.Redirect
								if user == "Guest" and controller == smart_dsr
								else frappe.PermissionError
							)
							with self.assertRaises(error):
								controller.get_context(frappe._dict())
					if sales_allowed:
						self.assertEqual(security.account_for(), user)
					else:
						error = frappe.AuthenticationError if user == "Guest" else frappe.PermissionError
						with self.assertRaises(error):
							security.account_for()
