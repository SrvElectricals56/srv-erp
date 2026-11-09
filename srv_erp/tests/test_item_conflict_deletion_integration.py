import unittest
from uuid import uuid4

import frappe
from frappe.model.delete_doc import check_if_doc_is_linked

from srv_erp import hooks


@unittest.skipUnless(getattr(frappe.local, "site", None), "Requires an isolated Frappe test site")
class TestItemConflictDeletionIntegration(unittest.TestCase):
	def setUp(self):
		self.prefix = "conflict-delete-" + uuid4().hex[:10]
		self.savepoint = "item_conflict_deletion"
		frappe.db.savepoint(self.savepoint)

	def tearDown(self):
		frappe.db.rollback(save_point=self.savepoint)

	def item(self, suffix, **fields):
		doc = frappe.new_doc("Item")
		doc.update(
			{
				"name": self.prefix + suffix,
				"item_code": self.prefix + suffix,
				"item_name": self.prefix + suffix,
				"stock_uom": "Nos",
				**fields,
			}
		)
		doc.db_insert()
		return doc

	def conflict(self, suffix, item, field="item_code", status="Open"):
		doc = frappe.new_doc("Brand Variant Rule Conflict")
		doc.update(
			{
				"name": self.prefix + suffix,
				"conflict_key": self.prefix + suffix,
				"brand": "Test Brand",
				"profile": "Test Profile",
				"revision": 1,
				"conflict_type": "Missing Required Attribute",
				"status": status,
				field: item.name,
			}
		)
		# Raw fixtures isolate deletion from unrelated Item/profile creation rules.
		doc.db_insert()
		return doc.name

	def test_variant_deletion_removes_open_and_resolved_conflicts_only(self):
		item = self.item("-variant")
		other = self.item("-other")
		conflicts = [
			self.conflict("-open", item),
			self.conflict("-resolved", item, status="Resolved"),
		]
		unrelated = self.conflict("-unrelated", other)
		with self.assertRaises(frappe.LinkExistsError):
			check_if_doc_is_linked(item)

		frappe.delete_doc("Item", item.name)

		self.assertFalse(frappe.db.exists("Item", item.name))
		for conflict in conflicts:
			self.assertFalse(frappe.db.exists("Brand Variant Rule Conflict", conflict))
		self.assertTrue(frappe.db.exists("Brand Variant Rule Conflict", unrelated))

	def test_template_deletion_removes_template_conflicts(self):
		item = self.item("-template", has_variants=1)
		conflict = self.conflict("-template-conflict", item, field="template_item")

		frappe.delete_doc("Item", item.name)

		self.assertFalse(frappe.db.exists("Item", item.name))
		self.assertFalse(frappe.db.exists("Brand Variant Rule Conflict", conflict))

	def test_other_item_links_still_block_and_rollback_restores_conflicts(self):
		item = self.item("-blocked", has_variants=1)
		request = frappe.new_doc("Dynamic Item Request")
		request.update({"name": self.prefix + "-request", "template_item": item.name})
		request.db_insert()
		conflict = self.conflict("-blocked-conflict", item)
		frappe.db.savepoint("blocked_item_delete")

		with self.assertRaises(frappe.LinkExistsError):
			frappe.delete_doc("Item", item.name)
		frappe.db.rollback(save_point="blocked_item_delete")

		self.assertTrue(frappe.db.exists("Item", item.name))
		self.assertTrue(frappe.db.exists("Brand Variant Rule Conflict", conflict))

	@unittest.skipUnless(
		"srv_erp.oem_catalog.hooks.item.protect_delete" in hooks.doc_events["Item"]["on_trash"],
		"OEM Item protection is not installed on this branch",
	)
	def test_oem_protection_runs_before_conflict_cleanup(self):
		item = self.item("-oem")
		conflict = self.conflict("-oem-conflict", item)
		binding = frappe.new_doc("OEM Item Binding")
		binding.update(
			{
				"name": self.prefix + "-binding",
				"specification": self.prefix + "-specification",
				"stock_item": item.name,
			}
		)
		binding.db_insert()

		with self.assertRaisesRegex(frappe.ValidationError, "bound OEM Item"):
			frappe.delete_doc("Item", item.name)

		self.assertTrue(frappe.db.exists("Item", item.name))
		self.assertTrue(frappe.db.exists("Brand Variant Rule Conflict", conflict))
