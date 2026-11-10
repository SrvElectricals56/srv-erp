import frappe
from frappe import _
from frappe.utils import flt


def validate_variant_uoms(doc, method=None):
	if not doc.variant_of:
		return
	template = frappe.get_doc("Item", doc.variant_of)
	actual = [(row.uom, flt(row.conversion_factor)) for row in doc.get("uoms") or []]
	expected = [(row.uom, flt(row.conversion_factor)) for row in template.get("uoms") or []]
	if actual != expected:
		frappe.throw(
			_("UOMs and conversion factors for variant {0} are controlled by template {1}. Change them on the template.").format(
				doc.item_code or doc.name, doc.variant_of
			)
		)
