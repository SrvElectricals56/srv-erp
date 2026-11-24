"""Guard proof before Frappe File can mutate bytes or remove attachment links."""

from frappe.core.doctype.file.file import File

from .security import protect_evidence_file


class DSREvidenceFile(File):
	def validate(self):
		protect_evidence_file(self)
		return super().validate()

	def on_trash(self):
		protect_evidence_file(self)
		return super().on_trash()
