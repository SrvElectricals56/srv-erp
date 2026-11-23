import frappe


def execute():
    existing = frappe.db.exists(
        "Custom Field",
        {
            "dt": "Sales Order",
            "fieldname": "brand_filter",
        },
    )
    if existing:
        field = frappe.get_doc("Custom Field", existing)
        if not field.reqd:
            field.reqd = 1
            field.save(ignore_permissions=True)
        return

    frappe.get_doc(
        {
            "doctype": "Custom Field",
            "dt": "Sales Order",
            "fieldname": "brand_filter",
            "label": "Brand / Marka",
            "fieldtype": "Link",
            "options": "Brand",
            "reqd": 1,
            "insert_after": "items_section",
            "description": "Select a brand to show only its items."
        }
    ).insert(ignore_permissions=True)
