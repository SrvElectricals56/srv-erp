"""Planner corrections to generated work without rewriting submitted production."""

import frappe
from frappe import _
from frappe.utils import flt, get_datetime

from srv_erp.production.permissions import company_allowed
from srv_erp.production.service import (
	ASSIGNMENT,
	SCHEDULE,
	lock_schedule,
	planning_date,
	positive_qty,
	refresh_schedule_progress,
	require_planner,
	submitted_qty,
)
from srv_erp.production.setup import validate_supervisor


def active_schedule(name):
	doc = frappe.get_doc(SCHEDULE, name)
	require_planner(doc.company)
	doc.check_permission("write")
	if lock_schedule(name) != 1:
		frappe.throw(_("Schedule {0} must be submitted and active before updating its plan.").format(name))
	return doc


@frappe.whitelist()
def get_plan(schedule):
	active_schedule(schedule)
	rows = frappe.get_all(
		ASSIGNMENT,
		filters={"schedule": schedule, "status": ["!=", "Cancelled"]},
		fields=[
			"name",
			"modified",
			"schedule_item",
			"template",
			"item_code",
			"item_name",
			"work_area",
			"planned_date",
			"supervisor",
			"target_qty",
			"completed_qty",
			"remaining_qty",
			"status",
			"uom",
		],
		order_by="planned_date, template, item_code, work_area, supervisor, name",
		limit_page_length=0,
	)
	for index, row in enumerate(rows, 1):
		row.row_number = index
	return rows


def row_context(index, doc):
	return _("Update row {0}: {1}, {2}, {3} ({4})").format(
		index, doc.item_code or doc.template, doc.work_area, doc.planned_date, doc.name
	)


@frappe.whitelist(methods=["POST"])
def update_plan(schedule, rows, reason=None, added=None, deleted=None):
	doc = active_schedule(schedule)
	rows = frappe.parse_json(rows)
	added = frappe.parse_json(added) or []
	deleted = frappe.parse_json(deleted) or []
	if (
		not all(isinstance(group, list) for group in (rows, added, deleted))
		or not 0 < len(rows) + len(added) + len(deleted) <= 1000
	):
		frappe.throw(_("Select between 1 and 1,000 dated plan rows to update."))
	reason = reason.strip() if isinstance(reason, str) else ""
	reason = reason or _("Updated through Update Submitted Production Plan")
	# The parent lock is shared by entries, cancellation and individual corrections.
	# Check every row before saving any, then roll back all saves if a hook fails.
	pending, seen = [], set()
	for index, row in enumerate(rows, 1):
		if (
			not isinstance(row, dict)
			or not isinstance(row.get("name"), str)
			or not row["name"]
			or row["name"] in seen
		):
			frappe.throw(_("Update row {0}: missing or repeated assignment reference.").format(index))
		seen.add(row["name"])
		try:
			index = int(row.get("row_number", index))
		except (TypeError, ValueError):
			frappe.throw(_("Invalid dated plan row number."))
		if frappe.db.get_value(ASSIGNMENT, row["name"], "schedule") != schedule:
			frappe.throw(
				_(
					"Update row {0}: assignment {1} does not belong to this schedule or no longer exists."
				).format(index, frappe.utils.escape_html(row["name"]))
			)
		try:
			assignment = frappe.get_doc(ASSIGNMENT, row["name"])
		except frappe.DoesNotExistError:
			frappe.throw(
				_("Update row {0}: assignment {1} no longer exists. Reopen Update Plan.").format(
					index, frappe.utils.escape_html(str(row["name"]))
				)
			)
		context = row_context(index, assignment)
		if assignment.schedule != schedule or assignment.status == "Cancelled":
			frappe.throw(_("{0}: this assignment does not belong to the active schedule.").format(context))
		assignment.check_permission("write")
		try:
			fresh = get_datetime(row.get("modified")) == get_datetime(assignment.modified)
		except (TypeError, ValueError):
			fresh = False
		completed = submitted_qty(assignment.name)
		if not row.get("modified") or not fresh or flt(row.get("completed_qty"), 6) != completed:
			frappe.throw(
				_("{0}: the plan or recorded production changed. Reopen Update Plan and try again.").format(
					context
				)
			)
		date = planning_date(row.get("planned_date"), _("Schedule Date"), context)
		qty = positive_qty(row.get("target_qty"), context)
		if qty < completed:
			frappe.throw(
				_("{0}: target {1} cannot be below submitted production {2} {3}.").format(
					context, qty, completed, assignment.uom
				)
			)
		validate_supervisor(row.get("supervisor"), context)
		if not company_allowed(doc.company, row["supervisor"]):
			frappe.throw(
				_("{0}: supervisor {1} cannot access company {2}.").format(
					context, row["supervisor"], doc.company
				)
			)
		values = {"planned_date": str(date), "target_qty": qty, "supervisor": row["supervisor"]}
		if any(str(assignment.get(key)) != str(value) for key, value in values.items()):
			pending.append((index, assignment, values))
	removals = []
	for row in deleted:
		if not isinstance(row, dict) or not isinstance(row.get("name"), str) or row["name"] in seen:
			frappe.throw(_("Invalid or repeated deleted plan reference."))
		seen.add(row["name"])
		source = frappe.get_doc(ASSIGNMENT, row["name"])
		if source.schedule != schedule or source.status == "Cancelled":
			frappe.throw(_("Deleted plan does not belong to the active schedule."))
		source.check_permission("write")
		if not row.get("modified") or get_datetime(row["modified"]) != get_datetime(source.modified):
			frappe.throw(_("The plan changed. Reopen Update Plan and try again."))
		if (
			submitted_qty(source.name)
			or frappe.db.exists("SRV Production Entry Item", {"assignment": source.name})
			or frappe.db.exists("SRV Production Entry", {"assignment": source.name})
		):
			frappe.throw(_("Cannot delete a dated plan referenced by a production entry."))
		removals.append(source)
	additions = prepare_added_plans(doc, added)
	if not pending and not additions and not removals:
		frappe.throw(_("No dates, supervisors or target quantities were changed."))
	check_collisions(schedule, pending, additions, {row.name for row in removals})
	frappe.db.savepoint("production_plan_update")
	try:
		for _index, assignment, values in pending:
			assignment.update(values)
			# Each action records a distinct reason even when planners reuse the same explanation.
			assignment.change_reason = f"{reason.strip()}\n[{frappe.utils.now()} · {frappe.session.user}]"
			assignment.flags.defer_schedule_progress = True
			assignment.save(ignore_version=False)
		for source in removals:
			source.db_set({"status": "Cancelled", "change_reason": reason.strip()})
			source.add_comment("Comment", _("Dated plan removed: {0}").format(frappe.utils.escape_html(reason.strip())))
		for source in additions:
			source.flags.from_production_schedule = True
			source.change_reason = reason.strip()
			if source.flags.new_schedule_item:
				source.flags.new_schedule_item.db_insert()
			source.insert(ignore_permissions=True)
		refresh_schedule_progress(schedule)
		doc.add_comment(
			"Comment",
			_("Plan updated: {0} edited, {1} added, {2} removed. Reason: {3}").format(
				len(pending), len(additions), len(removals), frappe.utils.escape_html(reason.strip())
			),
		)
	except Exception:
		frappe.db.rollback(save_point="production_plan_update")
		raise
	result = {"updated": len(pending)}
	if added or deleted:
		result.update(added=len(additions), deleted=len(removals))
	return result


def check_collisions(schedule, pending, additions=None, removed=None):
	"""Reject newly introduced collisions; retain existing historical overlaps."""
	all_rows = frappe.get_all(
		ASSIGNMENT,
		filters={"schedule": schedule, "status": ["!=", "Cancelled"]},
		fields=["name", "template", "item_code", "work_area", "supervisor", "planned_date"],
	)
	all_rows = [row for row in all_rows if row.name not in (removed or set())]
	for source in additions or []:
		row = frappe._dict({key: source.get(key) for key in ("template", "item_code", "work_area", "supervisor", "planned_date")})
		row.name = source.occurrence_key
		all_rows.append(row)
	new_names = {source.occurrence_key for source in additions or []}
	changes = {assignment.name: (index, values) for index, assignment, values in pending}
	for index, source in enumerate(additions or [], 1):
		changes[source.occurrence_key] = (index, {})
	original, final = {}, {}
	for row in all_rows:
		original[row.name] = tuple(
			str(row.get(key) or "")
			for key in ("template", "item_code", "work_area", "supervisor", "planned_date")
		)
		if row.name in changes:
			row.update(changes[row.name][1])
		key = tuple(
			str(row.get(field) or "")
			for field in ("template", "item_code", "work_area", "supervisor", "planned_date")
		)
		for other in final.get(key, []):
			if (row.name in changes or other in changes) and (
				original[row.name] != original[other] or row.name in new_names
			):
				frappe.throw(
					_(
						"Date collision: {0} and {1}, item {2}, operation {3}, supervisor {4}, date {5}. Choose separate dates or supervisors."
					).format(
						_("Update row {0} (assignment {1})").format(changes[row.name][0], row.name)
						if row.name in changes
						else _("Existing assignment {0}").format(row.name),
						_("Update row {0} (assignment {1})").format(changes[other][0], other)
						if other in changes
						else _("Existing assignment {0}").format(other),
						row.item_code or row.template,
						row.work_area,
						row.supervisor,
						row.planned_date,
					)
				)
		final.setdefault(key, []).append(row.name)


def prepare_added_plans(doc, rows):
	"""Validate templates and variants and prepare any new schedule item rows."""
	plans = []
	for index, row in enumerate(rows, 1):
		if not isinstance(row, dict):
			frappe.throw(_("Invalid new dated plan row."))
		template_code = row.get("item")
		# Older clients sent the planned variant as Item.
		selected = frappe.get_doc("Item", template_code)
		selected.check_permission("read")
		variant_code = row.get("item_code") or (selected.name if selected.variant_of else None)
		template = frappe.get_doc("Item", selected.variant_of or selected.name)
		template.check_permission("read")
		if template.disabled or not template.has_variants:
			frappe.throw(_("Select an enabled item template."))
		item_doc = frappe.get_doc("Item", variant_code) if variant_code else template
		item_doc.check_permission("read")
		if item_doc.disabled or (variant_code and (item_doc.variant_of != template.name or item_doc.has_variants)):
			frappe.throw(_("Select an enabled variant belonging to the selected item."))
		if item_doc.stock_uom != template.stock_uom:
			frappe.throw(_("Variant UOM must match the item template UOM."))
		item = next((item for item in doc.items if item.template == template.name and (item.item_code or "") == (variant_code or "")), None)
		context = _("New dated plan row {0}").format(index)
		date = planning_date(row.get("planned_date"), _("Schedule Date"), context)
		qty = positive_qty(row.get("target_qty"), context)
		supervisor = row.get("supervisor")
		validate_supervisor(supervisor, context)
		if not company_allowed(doc.company, supervisor):
			frappe.throw(_("Supervisor cannot access this company."))
		roles = doc.get("responsibilities") or []
		role = next((role for role in roles if role.work_area == row.get("work_area")), None)
		if roles and not role:
			frappe.throw(_("Select an operation belonging to this schedule."))
		new_item = None
		if not item:
			item = doc.append("items", {
				"template": template.name, "item_code": variant_code,
				"item_name": item_doc.item_name, "uom": item_doc.stock_uom,
				"from_date": str(date), "to_date": str(date), "frequency": "Once",
				"qty_per_occurrence": qty, "supervisor": supervisor,
			})
			item.name = frappe.generate_hash(length=10)
			item.docstatus = 1
			new_item = item
		plan = frappe.get_doc({
			"doctype": ASSIGNMENT, "schedule": doc.name, "schedule_item": item.name,
			"responsibility": role.name if role else None,
			"occurrence_key": f"{doc.name}:{item.name}:{date}:{frappe.generate_hash(length=10)}",
			"company": doc.company, "template": template.name, "item_code": variant_code,
			"item_name": item_doc.item_name, "uom": item_doc.stock_uom,
			"supervisor": supervisor, "work_area": role.work_area if role else "Production",
			"planned_date": str(date), "target_qty": qty,
		})
		plan.flags.new_schedule_item = new_item
		plans.append(plan)
	return plans
