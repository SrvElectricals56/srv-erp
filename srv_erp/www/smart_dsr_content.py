no_cache = 1


def get_context(context):
	import frappe
	from frappe.sessions import get_csrf_token

	from srv_erp.smart_dsr.security import account_for

	if frappe.session.user == "Guest":
		frappe.local.flags.redirect_location = "/login?redirect-to=/app/smart-dsr"
		raise frappe.Redirect(http_status_code=302)
	account_for()
	from srv_erp.smart_dsr.home import enabled

	context.salesperson_home = enabled()
	context.smart_dsr_embedded = True
	context.hide_navbar = True
	context.hide_footer = True
	context.smart_dsr_csrf_token = get_csrf_token()
	context.smart_dsr_desk_theme = frappe.db.get_value("User", frappe.session.user, "desk_theme") or "Light"
	context.no_cache = 1
	context.show_sidebar = False
	context.full_width = True
