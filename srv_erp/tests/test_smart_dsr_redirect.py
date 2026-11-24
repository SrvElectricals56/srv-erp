"""Legacy Smart DSR must always redirect; operational reads stay authenticated."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.www import smart_dsr


class TestSmartDSRRedirect(unittest.TestCase):
	def test_redirect_is_the_same_for_every_user_even_embed_queries(self):
		for user in ("Guest", "Administrator", "sales@example.com", "manager@example.com"):
			with (
				self.subTest(user=user),
				patch.object(frappe, "session", frappe._dict(user=user)),
				patch.object(frappe, "local", frappe._dict(flags=frappe._dict())),
				patch.object(frappe, "form_dict", frappe._dict(desk="1")),
			):
				with self.assertRaises(frappe.Redirect):
					smart_dsr.get_context(frappe._dict())
				self.assertEqual(frappe.local.flags.redirect_location, "/app/smart-dsr")

	def test_only_supported_query_parameters_are_forwarded(self):
		with (
			patch.object(frappe, "local", frappe._dict(flags=frappe._dict())),
			patch.object(
				frappe,
				"form_dict",
				frappe._dict(
					section="history", duty="DSR 1", desk="1", redirect_to="https://example.invalid"
				),
			),
		):
			with self.assertRaises(frappe.Redirect):
				smart_dsr.get_context(frappe._dict())
			self.assertEqual(
				frappe.local.flags.redirect_location, "/app/smart-dsr?section=history&duty=DSR+1"
			)
