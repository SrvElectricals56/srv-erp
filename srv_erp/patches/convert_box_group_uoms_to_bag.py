import frappe
from frappe import _
from frappe.utils import flt

from srv_erp.package_barcode.service import get_package_barcode_conversion_factor


def execute():
	convert_item_uom_rows()


def convert_item_uom_rows():
	groups = set()
	for root in ("Fan Box & Concealed", "Super Fan Rods"):
		bounds = frappe.db.get_value("Item Group", root, ["lft", "rgt"], as_dict=True)
		if bounds:
			groups.update(
				frappe.get_all(
					"Item Group",
					filters={"lft": [">=", bounds.lft], "rgt": ["<=", bounds.rgt]},
					pluck="name",
				)
			)
	if not groups:
		return 0
	items = frappe.get_all("Item", filters={"item_group": ["in", sorted(groups)]}, pluck="name")
	if not items:
		return 0
	parents = frappe.get_all(
		"UOM Conversion Detail",
		filters={"parenttype": "Item", "parentfield": "uoms", "parent": ["in", items], "uom": "Box"},
		pluck="parent",
	)
	changed = []
	for name in sorted(set(parents)):
		item = frappe.get_doc("Item", name)
		if any(item.get(field) == "Box" for field in ("stock_uom", "sales_uom", "purchase_uom")):
			frappe.throw(
				_("Item {0} still uses Box as a default UOM. Resolve its defaults before converting only its UOM rows to Bag.").format(name)
			)
		if frappe.db.exists("DocType", "OEM Item Binding") and frappe.db.exists(
			"OEM Item Binding", {"stock_item": name, "ownership": "Module Created"}
		):
			frappe.throw(_("Item {0} has immutable OEM UOMs and requires an approved change.").format(name))
		box = [row for row in item.uoms if row.uom == "Box"]
		bag = [row for row in item.uoms if row.uom == "Bag"]
		if len(box) != 1 or len(bag) > 1:
			frappe.throw(_("Item {0} has duplicate Box or Bag UOM rows. Resolve them before conversion.").format(name))
		if bag and flt(bag[0].conversion_factor) != flt(box[0].conversion_factor):
			frappe.throw(_("Item {0} has different Box and Bag conversion factors. Resolve them before conversion.").format(name))
		if bag:
			item.remove(box[0])
		else:
			box[0].uom = "Bag"
		changed.append(item)
	barcodes = prepare_package_barcodes(items, changed)
	if not changed and not barcodes:
		return 0
	if not frappe.db.exists("UOM", "Bag"):
		frappe.get_doc({"doctype": "UOM", "uom_name": "Bag"}).insert(ignore_permissions=True)
	for item in changed:
		# A data-only patch: keep defaults, transactions and other variant fields intact.
		for index, row in enumerate(item.uoms, start=1):
			row.idx = index
		item.update_child_table("uoms")
		frappe.db.set_value("Item", item.name, "modified", frappe.utils.now())
		frappe.clear_document_cache("Item", item.name)
	for name, factor in barcodes:
		frappe.db.set_value("Package Barcode", name, {"uom": "Bag", "conversion_factor": factor})
		frappe.clear_document_cache("Package Barcode", name)
	return len(changed)


def prepare_package_barcodes(items, changed_items):
	"""Capture legacy factors before removing the Item's Box conversion row."""
	changed = {item.name: item for item in changed_items}
	barcodes = frappe.get_all(
		"Package Barcode",
		filters={"item_code": ["in", items], "uom": "Box"},
		fields=["name", "barcode", "item_code", "conversion_factor"],
	)
	prepared = []
	for row in barcodes:
		item = changed.get(row.item_code) or frappe.get_doc("Item", row.item_code)
		if not any(uom.uom == "Bag" for uom in item.uoms):
			frappe.throw(_("Item {0} needs a Bag UOM row before converting its Package Barcodes.").format(item.name))
		factor = get_package_barcode_conversion_factor(
			row.barcode, row.item_code, "Box", row.conversion_factor
		)
		if factor <= 0:
			frappe.throw(_("Package Barcode {0} needs a positive conversion factor before conversion.").format(row.name))
		prepared.append((row.name, factor))
	return prepared
