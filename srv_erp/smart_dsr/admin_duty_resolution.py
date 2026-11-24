"""Explicit, audited completion of pending duty details supplied by an administrator."""

import base64
import hashlib
import io
from datetime import timedelta

import frappe
from frappe.utils import get_datetime, now_datetime

from . import admin, api


def meter_photo_valid(doc, phase):
	field = f"odometer_{phase}_photo"
	if not doc.get(field) or not doc.get(f"odometer_{phase}_sha256"):
		return False
	name = frappe.db.get_value(
		"File",
		{
			"file_url": doc.get(field),
			"is_private": 1,
			"attached_to_doctype": doc.doctype,
			"attached_to_name": doc.name,
			"attached_to_field": field,
		},
		"name",
	)
	try:
		return bool(
			name
			and hashlib.sha256(frappe.get_doc("File", name).get_content()).hexdigest()
			== doc.get(f"odometer_{phase}_sha256")
		)
	except (OSError, frappe.DoesNotExistError):
		return False


def requirements(doc, status):
	result = {
		"visits": [],
		"breaks": [],
		"stays": [],
		"odometer": [],
		"duty_started_at": doc.started_at,
		"duty_ended_at": doc.ended_at,
	}
	if status not in ("Closed", "Finalized") or doc.status == "Finalized":
		return result
	for row in frappe.get_all(
		"DSR Dealer Activity",
		filters={"duty": doc.name, "status": ["in", ["Open", "Completed"]]},
		fields=["name", "customer", "status", "arrived_at", "departed_at", "remarks", "photo_exception"],
		order_by="arrived_at asc",
		limit_page_length=0,
	):
		missing = not row.photo_exception and not api.valid_photo(row.name, doc.account)
		if row.status == "Open" or missing:
			result["visits"].append(
				{
					"name": row.name,
					"customer": row.customer,
					"customer_name": frappe.db.get_value("Customer", row.customer, "customer_name")
					or row.customer,
					"status": row.status,
					"arrived_at": row.arrived_at,
					"departed_at": row.departed_at,
					"photo_missing": missing,
				}
			)
	result["breaks"] = frappe.get_all(
		"DSR Break",
		filters={"duty": doc.name, "ended_at": ["is", "not set"]},
		fields=["name", "break_type", "started_at"],
		limit_page_length=0,
	)
	result["stays"] = frappe.get_all(
		"DSR Night Stay",
		filters={"duty": doc.name, "checked_out_at": ["is", "not set"]},
		fields=["name", "address", "checked_in_at"],
		limit_page_length=0,
	)
	if doc.get("odometer_required"):
		for phase in ("start", "end"):
			if not meter_photo_valid(doc, phase):
				result["odometer"].append(
					{
						"phase": phase,
						"reading": doc.get(f"odometer_{phase}"),
						"photo_missing": True,
						"earliest_reported_at": get_datetime(doc.started_at) - timedelta(minutes=15)
						if phase == "start"
						else doc.started_at,
					}
				)
	result["max_accuracy_m"] = float(api.settings().max_accuracy_m)
	return api.public_dates(result)


def reported_time(value, start, label, end=None):
	if not isinstance(value, str) or not value.strip():
		frappe.throw(f"Enter {label}.")
	try:
		stamp = api.capture_time(value)
	except (ValueError, TypeError):
		frappe.throw(f"Enter a valid {label}.")
	if stamp < get_datetime(start) or stamp > (get_datetime(end) if end else now_datetime()):
		frappe.throw(f"{label} must be after the start and no later than the duty end or current time.")
	return stamp


def text(value, label):
	if not isinstance(value, str) or not value.strip() or len(value) > 2000:
		frappe.throw(f"Enter {label} (up to 2,000 characters).")
	return value.strip()


def photo_bytes(payload):
	from PIL import Image

	if (
		not isinstance(payload, dict)
		or not isinstance(payload.get("content"), str)
		or len(payload["content"]) > 7_000_000
	):
		frappe.throw("Attach a JPEG or PNG photo up to 5 MB.")
	try:
		content = base64.b64decode(payload["content"], validate=True)
		if not content or len(content) > 5_000_000:
			raise ValueError()
		with Image.open(io.BytesIO(content)) as image:
			if image.format not in ("JPEG", "PNG") or not 10000 <= image.width * image.height <= 24_000_000:
				raise ValueError()
			ext = "jpg" if image.format == "JPEG" else "png"
			image.verify()
	except Exception:
		frappe.throw("Attach a valid JPEG or PNG photo up to 5 MB.")
	return content, ext


def attach_photo(content, filename, doctype, name, field=None):
	from frappe.utils.file_manager import save_file

	previous = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		return save_file(filename, content, doctype, name, is_private=1, df=field).file_url
	finally:
		frappe.flags.smart_dsr_evidence_write = previous


def owned_row(doctype, name, doc):
	row = frappe.get_doc(doctype, name, for_update=True)
	if row.duty != doc.name or row.account != doc.account:
		frappe.throw("The pending record does not belong to this duty.", frappe.PermissionError)
	return row


def apply(doc, values, request_key):
	values = admin.args(values)
	if not set(values).issubset({"visits", "breaks", "stays", "odometer"}):
		frappe.throw("Invalid pending duty details.")
	if doc.status not in ("Active", "Closed"):
		frappe.throw("Pending details can only be completed for an active or closed duty.")
	cutoff = doc.ended_at if doc.status == "Closed" else None
	for group in ("visits", "breaks", "stays", "odometer"):
		if group in values and (not isinstance(values[group], list) or len(values[group]) > 100):
			frappe.throw("Invalid pending duty records.")
		seen = set()
		for item in values.get(group, []):
			if not isinstance(item, dict):
				frappe.throw("Invalid pending duty details.")
			identifier = item.get("phase") if group == "odometer" else item.get("name")
			if not isinstance(identifier, str) or identifier in seen:
				frappe.throw("Select each pending record only once.")
			seen.add(identifier)
			why = f"Administrator supplied pending {group} details during duty status change."
			if group == "visits":
				row = owned_row("DSR Dealer Activity", identifier, doc)
				if row.status not in ("Open", "Completed"):
					frappe.throw("Only open or completed visits can be resolved.")
				if row.status == "Completed" and (
					row.photo_exception or api.valid_photo(row.name, doc.account)
				):
					frappe.throw("This visit has no pending completion details. Refresh the requirements.")
				before = {
					key: row.get(key)
					for key in (
						"status",
						"departed_at",
						"remarks",
						"photo_exception",
						"activity_duration_minutes",
					)
				}
				note = text(item.get("completion_note"), "visit completion details")
				if not row.photo_exception and not api.valid_photo(row.name, doc.account):
					if item.get("photo"):
						photo = item["photo"]
						content, ext = photo_bytes(photo)
						captured = reported_time(
							photo.get("reported_at"), row.arrived_at, "reported visit photo time", cutoff
						)
						evidence = api.insert(
							"DSR Dealer Photo Evidence",
							account=doc.account,
							duty=doc.name,
							activity=row.name,
							captured_at=captured,
							received_at=now_datetime(),
							sha256=hashlib.sha256(content).hexdigest(),
							capture_source="Administrator supplied; reported capture time",
						)
						evidence.photo = attach_photo(
							content, f"admin-visit-{row.name}.{ext}", evidence.doctype, evidence.name
						)
						api.save(evidence)
					else:
						row.photo_exception = "Administrator approved missing photo: " + text(
							item.get("photo_exception"), "missing photo exception details"
						)
				if row.status == "Open":
					row.departed_at = reported_time(
						item.get("departed_at"), row.arrived_at, "visit completion time", cutoff
					)
					row.activity_duration_minutes = (
						row.departed_at - get_datetime(row.arrived_at)
					).total_seconds() / 60
					row.status = "Completed"
				row.remarks = ((row.remarks or "") + "\nAdministrator completion: " + note).strip()
				api.save(row)
				after = {key: row.get(key) for key in before}
				after["source"] = "Administrator entry; no device GPS or reward points created"
			elif group == "breaks":
				row = owned_row("DSR Break", identifier, doc)
				if row.ended_at:
					frappe.throw("This break has already ended. Refresh pending details.")
				before = {"ended_at": row.ended_at, "duration_minutes": row.duration_minutes}
				row.ended_at = reported_time(
					item.get("ended_at"), row.started_at, "break ending time", cutoff
				)
				row.duration_minutes = (row.ended_at - get_datetime(row.started_at)).total_seconds() / 60
				api.save(row)
				after = {
					"ended_at": row.ended_at,
					"duration_minutes": row.duration_minutes,
					"source": "Administrator entry",
				}
			elif group == "stays":
				from .policy import distance, geofence

				row = owned_row("DSR Night Stay", identifier, doc)
				if row.checked_out_at:
					frappe.throw("This night stay has already ended. Refresh pending details.")
				checkout = reported_time(
					item.get("checked_out_at"), row.checked_in_at, "night stay checkout time", cutoff
				)
				elapsed = (checkout - get_datetime(row.checked_in_at)).total_seconds()
				point = api.location(item.get("gps"), require_precise=True)
				if (
					elapsed < 14400
					or geofence(
						row.as_dict(), point, radius=500, max_accuracy=float(api.settings().max_accuracy_m)
					)
					!= "Inside"
				):
					frappe.throw(
						"Night stay checkout requires at least 4 hours and a reported location within 500 metres of check-in."
					)
				before = {"checked_out_at": row.checked_out_at, "expense": row.expense}
				result = api.record_expense_document(
					doc,
					"Night Stay",
					1200,
					1,
					"automatic-night-stay:" + row.name,
					"Administrator supplied checkout details; eligible night stay.",
				)
				row.checked_out_at = checkout
				row.checkout_latitude, row.checkout_longitude, row.checkout_accuracy = (
					point["latitude"],
					point["longitude"],
					point["accuracy"],
				)
				row.checkout_distance_m, row.duration_minutes = (
					distance(row.as_dict(), point) * 1000,
					elapsed / 60,
				)
				row.expense, row.expense_amount, row.state = result["name"], 1200, "Inside"
				api.save(row)
				after = {
					"checked_out_at": checkout,
					"expense": row.expense,
					"reported_location": point,
					"source": "Administrator entry",
				}
			else:
				from .odometer import reading

				phase = identifier
				if phase not in ("start", "end") or not doc.get("odometer_required"):
					frappe.throw("Select a required starting or ending meter photo.")
				if meter_photo_valid(doc, phase):
					frappe.throw("Existing verified meter evidence cannot be replaced in this workflow.")
				content, ext = photo_bytes(item.get("photo"))
				earliest = (
					get_datetime(doc.started_at) - timedelta(minutes=15)
					if phase == "start"
					else doc.started_at
				)
				capture = reported_time(
					item.get("reported_at"), earliest, "reported meter photo time", cutoff
				)
				keys = [f"odometer_{phase}{suffix}" for suffix in ("", "_photo", "_sha256", "_captured_at")]
				before = {key: doc.get(key) for key in keys}
				doc.set(f"odometer_{phase}", reading(item.get("reading")))
				field = f"odometer_{phase}_photo"
				doc.set(
					field,
					attach_photo(
						content, f"admin-meter-{phase}-{doc.name}.{ext}", doc.doctype, doc.name, field
					),
				)
				doc.set(f"odometer_{phase}_sha256", hashlib.sha256(content).hexdigest())
				doc.set(f"odometer_{phase}_captured_at", capture)
				api.save(doc)
				row = doc
				after = {key: doc.get(key) for key in keys}
				after["source"] = "Administrator supplied; reported capture time"
			subkey = hashlib.sha256((request_key + ":" + group + ":" + identifier).encode()).hexdigest()
			admin.audit("Resolve pending duty details", row, before, after, why, subkey)
