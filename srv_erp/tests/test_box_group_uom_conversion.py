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
		if not frappe.db.exists("Item Group", "Fan Box & Concealed"):
			self.group("Fan Box & Concealed", "All Item Groups")
		for root in ("Concealed", "Fan Box"):
			if not frappe.db.exists("Item Group", root):
				self.group(root, "Fan Box & Concealed")
		self.child = self.group(self.prefix + "-child", "Concealed")
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
		template = self.item("-template", "Concealed", has_variants=1)
		items = [
			template,
			self.item("-variant", "Concealed", variant_of=template.name),
			self.item("-parent", "Fan Box & Concealed"),
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

	def test_followup_patch_covers_previously_missed_concealed_group(self):
		from srv_erp.patches.correct_box_bag_group_scope import execute

		concealed = self.item("-previously-missed", "Concealed")
		fan = self.item("-already-converted", "Fan Box")
		fan.uoms[1].uom = "Bag"
		fan.save()

		execute()
		concealed.reload()
		fan.reload()
		self.assertEqual(concealed.uoms[1].uom, "Bag")
		self.assertEqual(fan.uoms[1].uom, "Bag")
		self.assertEqual(fan.uoms[1].conversion_factor, 12)

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

	def barcode(self, suffix, item, factor=12, **fields):
		return frappe.get_doc(
			{
				"doctype": "Package Barcode",
				"barcode": self.prefix + suffix,
				"item_code": item.name,
				"uom": "Box",
				"conversion_factor": factor,
				**fields,
			}
		).insert()

	def test_package_barcodes_follow_group_scope_and_keep_printed_codes_and_factors(self):
		item = self.item("-barcode", self.grandchild.name)
		outside = self.item("-outside-barcode", self.outside.name)
		barcode = self.barcode("-printed-7PKG", item, factor=7)
		disabled = self.barcode("-disabled", item, factor=9, status="Disabled")
		untouched = self.barcode("-outside-printed", outside)
		original_code = barcode.barcode

		convert_item_uom_rows()

		barcode.reload()
		disabled.reload()
		untouched.reload()
		self.assertEqual((barcode.name, barcode.barcode), (original_code, original_code))
		self.assertEqual((barcode.uom, barcode.conversion_factor), ("Bag", 7))
		self.assertEqual((disabled.uom, disabled.conversion_factor, disabled.status), ("Bag", 9, "Disabled"))
		self.assertEqual(untouched.uom, "Box")
		from srv_erp.package_barcode.api import scan_package_barcode

		result = scan_package_barcode(original_code)
		self.assertEqual((result["uom"], result["conversion_factor"]), ("Bag", 7))
		modified = barcode.modified
		convert_item_uom_rows()
		barcode.reload()
		self.assertEqual(barcode.modified, modified)

	def test_legacy_barcode_factor_is_captured_before_item_box_row_is_removed(self):
		item = self.item("-legacy-barcode", self.child.name)
		legacy = self.barcode("-legacy-printed", item, factor=0)
		encoded = self.barcode("-encoded-5PKG", item, factor=0)

		convert_item_uom_rows()

		legacy.reload()
		encoded.reload()
		self.assertEqual((legacy.uom, legacy.conversion_factor), ("Bag", 12))
		self.assertEqual((encoded.uom, encoded.conversion_factor), ("Bag", 5))

	def test_package_barcodes_are_updated_when_item_was_already_converted(self):
		item = self.item("-converted", "Fan Box")
		item.uoms[1].uom = "Bag"
		item.save()
		barcode = self.barcode("-old-master", item)

		self.assertEqual(convert_item_uom_rows(), 0)

		barcode.reload()
		self.assertEqual((barcode.uom, barcode.conversion_factor), ("Bag", 12))

	def test_package_barcode_preflight_failure_leaves_item_rows_unchanged(self):
		item = self.item("-preflight", self.child.name)
		invalid = self.item("-no-bag", "Fan Box")
		invalid.remove(invalid.uoms[1])
		invalid.save()
		barcode = self.barcode("-unconfigured", invalid)

		with self.assertRaisesRegex(frappe.ValidationError, "needs a Bag UOM row"):
			convert_item_uom_rows()

		item.reload()
		barcode.reload()
		self.assertEqual(item.uoms[1].uom, "Box")
		self.assertEqual(barcode.uom, "Box")
