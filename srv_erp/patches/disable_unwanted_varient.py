



import traceback

import frappe
from frappe.model.rename_doc import rename_doc
from frappe.utils import flt, nowdate


CHUNK_SIZE = 500


def execute():
	"""Delete unused Item variants, or rename and disable them if deletion is blocked."""
	logger = frappe.logger("srv_erp.patches.disable_unwanted_varient")
	today = nowdate()
	_log(logger, "info", "Starting unused variant cleanup for stock balances through %s", today)
	counts = {"deleted": 0, "disabled": 0, "protected": 0, "failed": 0, "invalid_template": 0}
	last_name = None
	processed = 0

	while True:
		filters = {"variant_of": ("is", "set"), "disabled": 0}
		if last_name:
			filters["name"] = (">", last_name)

		chunk = frappe.get_all(
			"Item",
			filters=filters,
			fields=["name", "variant_of"],
			order_by="name asc",
			limit_page_length=CHUNK_SIZE,
		)
		if not chunk:
			break

		last_name = chunk[-1].name
		valid_templates = set(
			frappe.get_all(
				"Item",
				filters={
					"name": ("in", [item.variant_of for item in chunk]),
					"has_variants": 1,
				},
				pluck="name",
			)
		)
		variants = [item for item in chunk if item.variant_of in valid_templates]
		counts["invalid_template"] += len(chunk) - len(variants)
		if not variants:
			frappe.db.commit()
			continue

		item_codes = [item.name for item in variants]
		chunk_counts = {"deleted": 0, "disabled": 0, "protected": 0, "failed": 0}
		_log(
			logger,
			"info",
			"Checking next batch of %s variants for Sales Orders and stock",
			len(variants),
		)

		sales_order_items = set(
			frappe.get_all(
				"Sales Order Item",
				filters={"item_code": ("in", item_codes)},
				pluck="item_code",
			)
		)
		stock_balances = frappe.get_all(
			"Stock Ledger Entry",
			filters={
				"item_code": ("in", item_codes),
				"posting_date": ("<=", today),
				"is_cancelled": 0,
			},
			fields=["item_code", "warehouse", "sum(actual_qty) as balance"],
			group_by="item_code, warehouse",
		)
		items_with_stock = {
			row.item_code for row in stock_balances if flt(row.balance) != 0
		}

		for item in variants:
			has_sales_order = item.name in sales_order_items
			has_stock = item.name in items_with_stock
			if has_sales_order or has_stock:
				chunk_counts["protected"] += 1
				continue

			result = _delete_or_disable(item.name)
			chunk_counts[result] += 1

		for key, value in chunk_counts.items():
			counts[key] += value
		processed += len(chunk)
		frappe.db.commit()
		_log(logger, "info", "Processed %s Items; batch results: %s", processed, chunk_counts)

	_log(logger, "info", "Unused variant cleanup complete: %s", counts)


def _log(logger, level, message, *args):
	formatted_message = message % args if args else message
	getattr(logger, level)(message, *args)
	print(formatted_message, flush=True)


def _delete_or_disable(item_code):
	logger = frappe.logger("srv_erp.patches.disable_unwanted_varient")
	savepoint = "unused_variant_cleanup"
	frappe.db.savepoint(savepoint)
	try:
		frappe.delete_doc("Item", item_code, ignore_permissions=True)
		return "deleted"
	except Exception as delete_error:
		delete_error_traceback = traceback.format_exc()
		frappe.db.rollback(save_point=savepoint)
		_log(
			logger,
			"warning",
			"Could not delete Item %s: %s; attempting rename and disable fallback",
			item_code,
			delete_error,
		)

	try:
		frappe.db.savepoint(savepoint)
		new_item_code = f"{item_code}-unused"
		if frappe.db.exists("Item", new_item_code):
			frappe.throw(f"Cannot rename {item_code}: {new_item_code} already exists")

		rename_doc(
			"Item",
			item_code,
			new_item_code,
			force=True,
			show_alert=False,
			ignore_permissions=True,
		)
		item = frappe.get_doc("Item", new_item_code)
		item.disabled = 1
		item.save(ignore_permissions=True)
		return "disabled"
	except Exception as fallback_error:
		frappe.db.rollback(save_point=savepoint)
		fallback_error_traceback = traceback.format_exc()
		_log(
			logger,
			"error",
			"Could not rename and disable Item %s: %s",
			item_code,
			fallback_error,
		)
		frappe.log_error(
			title=f"Could not delete or disable Item {item_code}",
			message=(
				f"Delete failed:\n{delete_error_traceback}\n"
				f"Rename/disable failed:\n{fallback_error_traceback}"
			),
			reference_doctype="Item",
			reference_name=item_code,
		)
		return "failed"
