frappe.ui.form.on("Customer", {
	setup(frm) {
		frm.set_df_property("customer_group", "reqd", 1);
	},
});
