"""Odometer readings and private camera evidence; GPS distance remains independent."""

import base64
import hashlib
import io
import secrets
from decimal import Decimal, InvalidOperation

import frappe
from frappe.utils import now_datetime

from . import api
from .policy import indian_vehicle_number

PHOTO_FIELDS = frozenset({"odometer_start_photo", "odometer_end_photo"})


def reading(value):
	try:
		if value is None or isinstance(value, bool) or not str(value).strip() or len(str(value)) > 40:
			raise ValueError()
		number = Decimal(str(value))
		if not number.is_finite() or number < 0:
			raise ValueError()
		return float(number.quantize(Decimal("0.01")))
	except (ValueError, InvalidOperation, TypeError):
		frappe.throw("Enter a valid non-negative meter reading in KM.")


def difference(start, end):
	start, end = reading(start), reading(end)
	if end < start:
		frappe.throw("Ending meter reading cannot be lower than the starting reading.")
	return float(Decimal(str(end)) - Decimal(str(start)))


def context(phase, account, value, vehicle, request_key=None, duty=None):
	return {
		"phase": phase,
		"account": account,
		"reading": reading(value),
		"vehicle": vehicle,
		"request_key": request_key if phase == "start" else None,
		"duty": duty if phase == "end" else None,
	}


def new_challenge(phase, value, vehicle_number=None, request_key=None, duty=None):
	if phase not in ("start", "end"):
		frappe.throw("Choose a starting or ending meter capture.")
	value = reading(value)
	if phase == "start":
		account = api.identity(True)
		api.key(request_key, account)
		try:
			vehicle_number = indian_vehicle_number(vehicle_number)
		except ValueError as exc:
			frappe.throw(str(exc))
		if not frappe.db.exists("DSR Vehicle", {"registration_number": vehicle_number, "status": "Active"}):
			frappe.throw("Select an active vehicle before opening the meter camera.")
	else:
		doc = api.active(duty)
		account, vehicle_number = doc.account, doc.vehicle_number
		if doc.get("odometer_start_photo"):
			difference(doc.odometer_start, value)
	token = secrets.token_urlsafe(32)
	frappe.cache().set_value(
		"dsr-odometer:" + token,
		context(phase, account, value, vehicle_number, request_key, duty),
		expires_in_sec=300,
	)
	return token


def validate_photo(payload, expected):
	from PIL import Image

	payload = frappe.parse_json(payload) if isinstance(payload, str) else payload
	if (
		not isinstance(payload, dict)
		or not isinstance(payload.get("challenge"), str)
		or len(payload["challenge"]) > 128
	):
		frappe.throw("Capture the meter using the live camera.")
	if frappe.cache().get_value("dsr-odometer:" + payload["challenge"]) != expected:
		frappe.throw("Meter camera session expired or the reading/vehicle changed. Retake the meter photo.")
	try:
		encoded = payload.get("content")
		if not isinstance(encoded, str) or len(encoded) > 7_000_000:
			raise ValueError()
		data = base64.b64decode(encoded, validate=True)
		if not data or len(data) > 5_000_000:
			raise ValueError()
		with Image.open(io.BytesIO(data)) as image:
			if image.format != "JPEG" or not 10000 <= image.width * image.height <= 24_000_000:
				raise ValueError()
			image.verify()
	except Exception:
		frappe.throw("Capture a valid meter photo using the live camera (up to 5 MB).")
	return {
		"data": data,
		"challenge": payload["challenge"],
		"captured_at": now_datetime(),
	}


def attach_photo(doc, phase, photo):
	from frappe.utils.file_manager import save_file

	field = "odometer_" + phase + "_photo"
	previous = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		file = save_file(
			f"odometer-{phase}-{doc.name}.jpg", photo["data"], doc.doctype, doc.name, is_private=1, df=field
		)
	finally:
		frappe.flags.smart_dsr_evidence_write = previous
	digest = saved_photo_sha256(file.name)
	doc.set(field, file.file_url)
	doc.set("odometer_" + phase + "_sha256", digest)
	doc.set("odometer_" + phase + "_captured_at", photo["captured_at"])
	frappe.db.after_commit.add(lambda: frappe.cache().delete_value("dsr-odometer:" + photo["challenge"]))


def photo_sha256(file_name):
	try:
		content = frappe.get_doc("File", file_name).get_content()
	except (OSError, frappe.DoesNotExistError):
		return None
	if isinstance(content, bytes) and content:
		return hashlib.sha256(content).hexdigest()
	return None


def saved_photo_sha256(file_name):
	# Frappe can re-encode uploaded JPEGs while stripping EXIF metadata.
	digest = photo_sha256(file_name)
	if not digest:
		frappe.throw("The saved photo could not be verified. Capture or attach it again.")
	return digest


def meter_photo_valid(doc, phase):
	field = "odometer_" + phase + "_photo"
	url, digest = doc.get(field), doc.get("odometer_" + phase + "_sha256")
	if url and digest:
		name = frappe.db.get_value(
			"File",
			{
				"file_url": url,
				"is_private": 1,
				"attached_to_doctype": doc.doctype,
				"attached_to_name": doc.name,
				"attached_to_field": field,
			},
			"name",
		)
		if name:
			return photo_sha256(name) == digest
	return False


def validate_stored_photo(doc, phase):
	if not meter_photo_valid(doc, phase):
		frappe.throw(f"The {phase}ing meter photo is missing or changed. Contact an Administrator.")
