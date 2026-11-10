import unittest
from uuid import uuid4

import frappe


@unittest.skipUnless(getattr(frappe.local, "site", None), "Requires an isolated Frappe test site")
class TestVariantUOMGuard(unittest.TestCase):
	def setUp(self):
		frappe.db.savepoint("variant_uom_guard_test")
		self.prefix = "uom-guard-" + uuid4().hex[:8]
		frappe.db.set_single_value("Masters Settings", "enforce_variant_approval", 0)
		frappe.db.set_single_value("Item Variant Settings", "do_not_update_variants", 1)
		frappe.clear_document_cache("Masters Settings", "Masters Settings")
		for uom in ("Nos", "Box", "Bag"):
			if not frappe.db.exists("UOM", uom):
				frappe.get_doc({"doctype": "UOM", "uom_name": uom}).insert()
		self.template = self.make_item("-template", has_variants=1)
		self.variant = self.make_item("-variant", variant_of=self.template.name)

	def tearDown(self):
		frappe.db.rollback(save_point="variant_uom_guard_test")
		frappe.clear_document_cache("Masters Settings", "Masters Settings")

	def make_item(self, suffix, **fields):
		return frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": self.prefix + suffix,
				"item_name": self.prefix + suffix,
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"variant_based_on": "Manufacturer",
				"uoms": [
					{"uom": "Nos", "conversion_factor": 1},
					{"uom": "Box", "conversion_factor": 12},
				],
				**fields,
			}
		).insert()

	def test_variant_factor_edit_is_blocked(self):
		self.variant.uoms[1].conversion_factor = 24
		with self.assertRaisesRegex(frappe.ValidationError, "controlled by template"):
			self.variant.save()

	def test_variant_row_addition_is_blocked(self):
		self.variant.append("uoms", {"uom": "Bag", "conversion_factor": 48})
		with self.assertRaisesRegex(frappe.ValidationError, "controlled by template"):
			self.variant.save()

	def test_variant_row_removal_is_blocked(self):
		self.variant.remove(self.variant.uoms[1])
		with self.assertRaisesRegex(frappe.ValidationError, "controlled by template"):
			self.variant.save()

	def test_unchanged_variant_can_save(self):
		self.variant.disabled = 1
		self.variant.save()
		self.variant.reload()
		self.assertEqual(self.variant.disabled, 1)

	def test_template_edit_and_matching_variant_update_are_allowed(self):
		self.template.uoms[1].conversion_factor = 24
		self.template.save()
		self.variant.reload()
		self.variant.uoms[1].conversion_factor = 24
		self.variant.save()
		self.variant.reload()
		self.assertEqual(self.variant.uoms[1].conversion_factor, 24)
