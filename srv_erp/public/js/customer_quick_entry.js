(function () {
	"use strict";

	window.__srv_customer_quick_entry_asset_loaded = true;

	function install_customer_quick_entry() {
		const CustomerQuickEntryForm = frappe.ui?.form?.CustomerQuickEntryForm;

		if (!CustomerQuickEntryForm) {
			return false;
		}

		if (CustomerQuickEntryForm.__srv_customer_group_positioned) {
			return true;
		}

		class SRVCustomerQuickEntryForm extends CustomerQuickEntryForm {
			set_meta_and_mandatory_fields() {
				super.set_meta_and_mandatory_fields();

				const customer_group = this.meta.fields.find(
					(field) => field.fieldname === "customer_group"
				);

				if (!customer_group) {
					return;
				}

				// Avoid duplicates when Customer Group is already enabled for Quick Entry
				// through site customization, then place it directly after Customer Name.
				this.mandatory = this.mandatory.filter(
					(field) => field.fieldname !== "customer_group"
				);

				const customer_name_index = this.mandatory.findIndex(
					(field) => field.fieldname === "customer_name"
				);
				const insert_at = customer_name_index >= 0 ? customer_name_index + 1 : 0;

				this.mandatory.splice(insert_at, 0, {
					...customer_group,
					allow_in_quick_entry: 1,
				});
			}
		}

		SRVCustomerQuickEntryForm.__srv_customer_group_positioned = true;
		frappe.ui.form.CustomerQuickEntryForm = SRVCustomerQuickEntryForm;
		return true;
	}

	// ERPNext's bundle and app_include_js assets may execute in parallel. Keep
	// checking during initial Desk startup so an ERPNext controller assignment
	// that happens after this file cannot overwrite the customization.
	install_customer_quick_entry();
	let attempts = 0;
	const installer = window.setInterval(() => {
		attempts += 1;
		install_customer_quick_entry();
		if (attempts >= 200) {
			window.clearInterval(installer);
		}
	}, 50);
})();
