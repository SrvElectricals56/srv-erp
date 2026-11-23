/* Keep the server-issued return reference scoped to this browser tab. */
frappe.ui.form.on("Sales Order", {
	refresh(frm) {
		let ref;
		try {
			ref = JSON.parse(sessionStorage.getItem("dsr-order-return") || "null");
		} catch (_) {
			return;
		}
		if (!ref) return;
		frm.add_custom_button(__("Back to DSR"), () => {
			sessionStorage.removeItem("dsr-order-return");
			location.assign("/app/smart-dsr#visit/" + encodeURIComponent(ref.activity));
		});
		if (frm.is_new() && !frm.doc.customer) frm.set_value("customer", ref.customer);
		if (frm.doc.docstatus === 1 && frm.doc.customer === ref.customer && !frm.__dsr_linking) {
			frm.__dsr_linking = true;
			frappe
				.call({
					method: "srv_erp.smart_dsr.api.link_visit_order",
					args: { token: ref.token, order: frm.doc.name },
				})
				.then(() => {
					sessionStorage.removeItem("dsr-order-return");
					location.assign("/app/smart-dsr#visit/" + encodeURIComponent(ref.activity));
				})
				.catch(() => {
					frm.__dsr_linking = false;
				});
		}
	},
});
