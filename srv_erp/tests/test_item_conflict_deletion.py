import unittest
from types import SimpleNamespace
from unittest.mock import patch

from srv_erp import hooks
from srv_erp.masters.dynamic_item.brand_rule_conflicts import delete_item_conflicts


class TestItemConflictDeletion(unittest.TestCase):
	@patch("srv_erp.masters.dynamic_item.brand_rule_conflicts.frappe.delete_doc")
	@patch("srv_erp.masters.dynamic_item.brand_rule_conflicts.frappe.get_all")
	def test_deletes_all_conflicts_for_variant_or_template(self, get_all, delete_doc):
		get_all.return_value = ["open-conflict", "resolved-conflict"]

		delete_item_conflicts(SimpleNamespace(name="DB 517-TMT"), "on_trash")

		get_all.assert_called_once_with(
			"Brand Variant Rule Conflict",
			or_filters={"item_code": "DB 517-TMT", "template_item": "DB 517-TMT"},
			pluck="name",
		)
		self.assertEqual(delete_doc.call_count, 2)
		for name in get_all.return_value:
			delete_doc.assert_any_call("Brand Variant Rule Conflict", name, ignore_permissions=True)

	@patch("srv_erp.masters.dynamic_item.brand_rule_conflicts.frappe.delete_doc")
	@patch("srv_erp.masters.dynamic_item.brand_rule_conflicts.frappe.get_all", return_value=[])
	def test_item_without_conflicts_needs_no_cleanup(self, _get_all, delete_doc):
		delete_item_conflicts(SimpleNamespace(name="DB 518-TMT"))

		delete_doc.assert_not_called()

	def test_cleanup_is_registered_without_overriding_other_item_hooks(self):
		item_hooks = hooks.doc_events["Item"]["on_trash"]
		self.assertIn(
			"srv_erp.masters.dynamic_item.brand_rule_conflicts.delete_item_conflicts", item_hooks
		)
		if "srv_erp.oem_catalog.hooks.item.protect_delete" in item_hooks:
			self.assertLess(
				item_hooks.index("srv_erp.oem_catalog.hooks.item.protect_delete"),
				item_hooks.index("srv_erp.masters.dynamic_item.brand_rule_conflicts.delete_item_conflicts"),
			)
