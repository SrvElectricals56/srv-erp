$(document).on("app_ready", function () {
	if (!frappe.boot.smart_dsr_admin_access) return;
	frappe.search.utils.make_function_searchable(function () {
		window.location.assign("/smart-dsr/admin");
	}, "Smart DSR Admin");
});
