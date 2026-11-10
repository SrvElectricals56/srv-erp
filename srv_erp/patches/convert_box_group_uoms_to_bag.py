import frappe
from frappe import _
from frappe.utils import flt


def execute():
	convert_item_uom_rows()


def convert_item_uom_rows():
	groups = set()
	for root in ("Fan Box & Concealed",):
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
	if not changed:
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
	return len(changed)
