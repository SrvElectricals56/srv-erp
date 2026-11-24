frappe.ui.form.on("Dealer Overdue Receipt", {
	refresh(frm) {
		frm.add_custom_button(__("Back to Overdues"), () => frappe.set_route("overdues"));
	},
});
