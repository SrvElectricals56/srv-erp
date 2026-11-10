import frappe
from frappe import _
from frappe.utils import flt


def uom_values(doc):
	return [(row.uom, flt(row.conversion_factor)) for row in doc.get("uoms") or []]


def inherit_new_variant_uoms(doc, method=None):
	if doc.variant_of and doc.is_new():
		copy_uoms(frappe.get_doc("Item", doc.variant_of), doc)


def copy_uoms(template, variant):
	if template.stock_uom != variant.stock_uom:
		frappe.throw(
			_("Stock UOM for variant {0} must match template {1} before syncing UOMs.").format(
				variant.name or variant.item_code, template.name
			)
		)
	variant.set(
		"uoms",
		[{"uom": uom, "conversion_factor": factor} for uom, factor in uom_values(template)],
	)


def sync_template_uoms(doc, method=None):
	if doc.variant_of or not doc.has_variants:
		return 0
	previous = doc.get_doc_before_save()
	if previous and uom_values(previous) == uom_values(doc):
		return 0
	return sync_variant_uoms(doc)


def sync_variant_uoms(template):
	updated = 0
	for name in frappe.get_all("Item", filters={"variant_of": template.name}, pluck="name"):
		variant = frappe.get_doc("Item", name)
		if uom_values(variant) == uom_values(template):
			continue
		copy_uoms(template, variant)
		# Item authorization covers its variants; normal validation still applies.
		variant.save(ignore_permissions=True)
		updated += 1
	return updated


def sync_all_variant_uoms():
	updated = 0
	for name in frappe.get_all("Item", filters={"has_variants": 1}, pluck="name"):
		updated += sync_variant_uoms(frappe.get_doc("Item", name))
	return updated
