frappe.ui.form.on("Customer", {
	refresh(frm) {
		const max_date = frappe.datetime.str_to_obj(frappe.datetime.get_today());
		for (const fieldname of ["custom_date_of_birth", "custom_marriage_anniversary"]) {
			const field = frm.fields_dict[fieldname];
			if (field) {
				field.df.max_date = max_date;
				field.datepicker?.update("maxDate", max_date);
			}
		}
	},
	setup(frm) {
		frm.set_df_property("customer_group", "reqd", 1);
	},
});
