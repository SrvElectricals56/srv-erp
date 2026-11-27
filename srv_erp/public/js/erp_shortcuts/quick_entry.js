function can_create(doctype) {
	return !frappe.model.can_create || frappe.model.can_create(doctype);
}

function show_permission_message(doctype) {
	frappe.msgprint({
		title: __("Not Permitted"),
		message: __("You do not have permission to create {0}.", [__(doctype)]),
		indicator: "orange",
	});
}

function get_active_sales_order() {
	const frm = window.cur_frm;
	if (frm && frm.doctype === "Sales Order" && frm.doc.docstatus === 0) {
		return frm;
	}
	return null;
}

export async function add_item_to_sales_order(frm, item) {
	if (!frm || frm.doc.docstatus !== 0 || !item || !item.name) {
		return;
	}

	const row = (frm.doc.items || []).find((entry) => !entry.item_code) || frm.add_child("items");
	await frappe.model.set_value(row.doctype, row.name, "item_code", item.name);
	frm.refresh_field("items");

	const grid_row = frm.fields_dict.items.grid.grid_rows_by_docname[row.name];
	if (grid_row) {
		grid_row.toggle_view(true);
		grid_row.get_field("qty")?.set_focus();
	}
}

export function create_item(frm = get_active_sales_order()) {
	if (!can_create("Item")) {
		show_permission_message("Item");
		return;
	}

	return frappe.ui.form.make_quick_entry("Item", (item) => {
		if (frm) {
			void add_item_to_sales_order(frm, item);
		}
	});
}
