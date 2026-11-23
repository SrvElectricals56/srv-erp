// Historical DSR documents remain available in Desk.
frappe.ui.form.on("DSR", {
	refresh(frm) {
		frm.add_custom_button(__("Open Smart DSR"), () => window.location.assign("/smart-dsr"));
		if (frm.is_new()) {
			frm.disable_save();
			frm.set_intro(__("Start Duty ON in Smart DSR to create your daily report."));
		}
		if (frm.doc.smart_dsr) frm.disable_save();
	},
});
