"""Legacy Smart DSR URL: always enter through Desk."""

no_cache = 1


def get_context(context):
	from urllib.parse import urlencode

	import frappe

	# Preserve supported deep links without forwarding arbitrary request parameters.
	query = {key: frappe.form_dict[key] for key in ("section", "duty") if frappe.form_dict.get(key)}
	frappe.local.flags.redirect_location = "/app/smart-dsr" + ("?" + urlencode(query) if query else "")
	raise frappe.Redirect(http_status_code=302)
