"""Store and protect private Smart DSR evidence attachments."""

import frappe
from frappe.core.doctype.file.file import File

from .security import protect_evidence_file


class DSREvidenceFile(File):
	def save_file(self, content=None, decode=False, ignore_existing_file_check=False, overwrite=False):
		return super().save_file(
			content,
			decode,
			ignore_existing_file_check=ignore_existing_file_check or bool(self.flags.smart_dsr_unique_photo),
			overwrite=overwrite,
		)

	def validate(self):
		protect_evidence_file(self)
		return super().validate()

	def on_trash(self):
		protect_evidence_file(self)
		return super().on_trash()


def store_private_photo(filename, content, doc, field=None):
	# Camera endpoints supply validated bytes. Each attachment owns its blob even if another account
	# uploaded the same bytes, so Frappe never needs to reuse a different account's private file.
	file = frappe.get_doc(
		{
			"doctype": "File",
			"file_name": filename,
			"content": content,
			"is_private": 1,
			"attached_to_doctype": doc.doctype,
			"attached_to_name": doc.name,
			"attached_to_field": field,
		}
	)
	file.flags.smart_dsr_unique_photo = True
	file.flags.ignore_duplicate_entry_error = True
	previous = frappe.flags.smart_dsr_evidence_write
	frappe.flags.smart_dsr_evidence_write = True
	try:
		return file.insert(ignore_permissions=True)
	finally:
		frappe.flags.smart_dsr_evidence_write = previous
