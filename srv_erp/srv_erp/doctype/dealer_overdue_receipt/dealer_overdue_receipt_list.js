frappe.listview_settings["Dealer Overdue Receipt"] = {
	add_fields: [
		"currency",
		"balance_snapshot_available",
		"dues_amount",
		"amount",
		"leftover_dues",
	],
	onload(listview) {
		listview.page.add_inner_button(__("Back to Overdues"), () => frappe.set_route("overdues"));
		// Keep all three balance columns visible alongside dealer and date.
		listview.list_view_settings.total_fields = 7;
		listview.list_view_settings.fields = JSON.stringify(
			["customer", "received_date", "dues_amount", "amount", "leftover_dues"].map(
				(fieldname) => ({ fieldname })
			)
		);
		listview.setup_columns();
		listview.render_header(true);
	},
	formatters: {
		dues_amount(value, df, doc) {
			return doc.balance_snapshot_available ? frappe.format(value, df, null, doc) : "—";
		},
		leftover_dues(value, df, doc) {
			return doc.balance_snapshot_available ? frappe.format(value, df, null, doc) : "—";
		},
	},
};
