import unittest
from uuid import uuid4

import frappe

from srv_erp.patches.convert_box_group_uoms_to_bag import convert_item_uom_rows


@unittest.skipUnless(getattr(frappe.local, "site", None), "Requires an isolated Frappe test site")
class TestBoxGroupUOMConversion(unittest.TestCase):
	def setUp(self):
		frappe.db.savepoint("box_group_uom_test")
		self.prefix = "box-bag-" + uuid4().hex[:8]
		frappe.db.set_single_value("Masters Settings", "enforce_variant_approval", 0)
		frappe.clear_document_cache("Masters Settings", "Masters Settings")
		for uom in ("Nos", "Box", "Bag"):
			if not frappe.db.exists("UOM", uom):
				frappe.get_doc({"doctype": "UOM", "uom_name": uom}).insert()
		for root in ("Concealed Box", "Fan Box"):
			if not frappe.db.exists("Item Group", root):
				self.group(root, "All Item Groups")
		self.child = self.group(self.prefix + "-child", "Concealed Box")
		self.grandchild = self.group(self.prefix + "-grandchild", self.child.name)
		self.outside = self.group(self.prefix + "-Fan Box Accessories", "All Item Groups")

	def tearDown(self):
		frappe.db.rollback(save_point="box_group_uom_test")
		frappe.clear_document_cache("Masters Settings", "Masters Settings")

	def group(self, name, parent):
		return frappe.get_doc(
			{"doctype": "Item Group", "item_group_name": name, "parent_item_group": parent, "is_group": 1}
		).insert()

	def item(self, suffix, group, **fields):
		return frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": self.prefix + suffix,
				"item_name": self.prefix + suffix,
				"item_group": group,
				"stock_uom": "Nos",
				"variant_based_on": "Manufacturer",
				"uoms": [{"uom": "Nos", "conversion_factor": 1}, {"uom": "Box", "conversion_factor": 12}],
				**fields,
			}
		).insert()

	def test_roots_descendants_templates_and_variants_are_converted(self):
		template = self.item("-template", "Concealed Box", has_variants=1)
		items = [
			template,
			self.item("-variant", "Concealed Box", variant_of=template.name),
			self.item("-fan", "Fan Box"),
			self.item("-child", self.child.name),
			self.item("-grandchild", self.grandchild.name),
		]
		outside = self.item("-outside", self.outside.name)
		self.assertEqual(convert_item_uom_rows(), len(items))
		for item in items:
			old_row_name = item.uoms[1].name
			item.reload()
			self.assertEqual([(row.uom, row.conversion_factor) for row in item.uoms], [("Nos", 1), ("Bag", 12)])
			self.assertEqual(item.uoms[1].name, old_row_name)
			self.assertEqual(item.stock_uom, "Nos")
			self.assertFalse(item.sales_uom)
			self.assertFalse(item.purchase_uom)
		outside.reload()
		self.assertEqual(outside.uoms[1].uom, "Box")
		self.assertEqual(convert_item_uom_rows(), 0)

	def test_matching_bag_row_is_deduplicated(self):
		item = self.item("-same", self.child.name)
		item.append("uoms", {"uom": "Bag", "conversion_factor": 12})
		item.save()
		self.assertEqual(convert_item_uom_rows(), 1)
		item.reload()
		self.assertEqual([(row.uom, row.conversion_factor, row.idx) for row in item.uoms], [("Nos", 1, 1), ("Bag", 12, 2)])

	def test_conflicting_bag_factor_stops_before_any_writes(self):
		first = self.item("-a", self.child.name)
		conflict = self.item("-z", self.child.name)
		conflict.append("uoms", {"uom": "Bag", "conversion_factor": 24})
		conflict.save()
		with self.assertRaisesRegex(frappe.ValidationError, "different Box and Bag"):
			convert_item_uom_rows()
		first.reload()
		self.assertEqual(first.uoms[1].uom, "Box")

	def test_default_uom_is_preserved_and_conversion_is_refused(self):
		item = self.item("-default", self.child.name, sales_uom="Box")
		with self.assertRaisesRegex(frappe.ValidationError, "still uses Box as a default"):
			convert_item_uom_rows()
		item.reload()
		self.assertEqual(item.sales_uom, "Box")
		self.assertEqual(item.uoms[1].uom, "Box")
