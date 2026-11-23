no_cache = 1


def get_context(context):
	import frappe
	from frappe.sessions import get_csrf_token

	from srv_erp.smart_dsr.admin_permissions import require_admin

	require_admin()
	if frappe.form_dict.get("desk") != "1":
		frappe.local.flags.redirect_location = "/app/smart-dsr/admin"
		raise frappe.Redirect(http_status_code=302)
	context.smart_dsr_csrf_token = get_csrf_token()
	context.smart_dsr_desk_theme = frappe.db.get_value("User", frappe.session.user, "desk_theme") or "Light"
	context.no_cache = 1
	context.show_sidebar = False
	context.full_width = True
