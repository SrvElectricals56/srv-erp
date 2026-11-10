import unittest
from uuid import uuid4

import frappe
from erpnext.controllers.item_variant import create_variant

from srv_erp.item.variant_uom_sync import sync_variant_uoms, uom_values


@unittest.skipUnless(getattr(frappe.local, "site", None), "Requires an isolated Frappe test site")
class TestVariantUOMSync(unittest.TestCase):
	def setUp(self):
		frappe.db.savepoint("variant_uom_test")
		self.prefix = "uom-sync-" + uuid4().hex[:8]
		frappe.db.set_single_value("Masters Settings", "enforce_variant_approval", 0)
		frappe.db.set_single_value("Item Variant Settings", "do_not_update_variants", 1)
		frappe.clear_document_cache("Masters Settings", "Masters Settings")
		for uom in ("Nos", "Box", "Bag"):
			if not frappe.db.exists("UOM", uom):
				frappe.get_doc({"doctype": "UOM", "uom_name": uom}).insert()
		self.attribute = frappe.get_doc(
			{
				"doctype": "Item Attribute",
				"attribute_name": self.prefix,
				"item_attribute_values": [{"attribute_value": "Small", "abbr": "S"}],
			}
		).insert()
		self.template = frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": self.prefix,
				"item_name": self.prefix,
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"has_variants": 1,
				"variant_based_on": "Item Attribute",
				"attributes": [{"attribute": self.attribute.name}],
				"uoms": [
					{"uom": "Nos", "conversion_factor": 1},
					{"uom": "Box", "conversion_factor": 12},
				],
			}
		).insert()
		self.template.reload()

	def tearDown(self):
		frappe.db.rollback(save_point="variant_uom_test")
		frappe.clear_document_cache("Masters Settings", "Masters Settings")

	def variant(self):
		return create_variant(self.template.name, {self.attribute.name: "Small"}).insert()

	def test_new_variant_inherits_all_uoms_and_factors(self):
		variant = self.variant()
		self.assertEqual(uom_values(variant), uom_values(self.template))
		self.assertNotEqual(variant.uoms[0].name, self.template.uoms[0].name)

	def test_template_add_change_and_remove_propagates(self):
		variant = self.variant()
		self.template.uoms[1].conversion_factor = 24
		self.template.append("uoms", {"uom": "Bag", "conversion_factor": 48})
		self.template.save()
		variant.reload()
		self.assertEqual(uom_values(variant), uom_values(self.template))
		self.template.remove(self.template.uoms[1])
		self.template.save()
		variant.reload()
		self.assertEqual(uom_values(variant), uom_values(self.template))

	def test_backfill_repairs_legacy_rows_and_is_idempotent(self):
		variant = self.variant()
		frappe.db.set_value("UOM Conversion Detail", variant.uoms[1].name, "conversion_factor", 3)
		self.assertEqual(sync_variant_uoms(self.template), 1)
		variant.reload()
		self.assertEqual(uom_values(variant), uom_values(self.template))
		modified = variant.modified
		self.assertEqual(sync_variant_uoms(self.template), 0)
		variant.reload()
		self.assertEqual(variant.modified, modified)

	def test_sync_also_works_with_standard_variant_updates_enabled(self):
		variant = self.variant()
		frappe.db.set_single_value("Item Variant Settings", "do_not_update_variants", 0)
		self.template.uoms[1].conversion_factor = 36
		self.template.save()
		variant.reload()
		self.assertEqual(uom_values(variant), uom_values(self.template))
