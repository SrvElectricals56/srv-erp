from unittest import TestCase
from unittest.mock import MagicMock, patch

import frappe

from srv_erp.customer.customer import validate_unique_gstin


class TestCustomerGSTIN(TestCase):
	@patch("srv_erp.customer.customer.frappe.db", new_callable=MagicMock)
	def test_disabled_customer_allows_duplicate_without_query(self, db):
		for disabled in (1, "1"):
			doc = frappe._dict(name="CUST-001", gstin=" 27aapfu0939f1zv ", disabled=disabled)
			validate_unique_gstin(doc)
			self.assertEqual(doc.gstin, "27AAPFU0939F1ZV")
		db.sql.assert_not_called()

	@patch("srv_erp.customer.customer.frappe.db", new_callable=MagicMock)
	def test_enabled_customer_checks_only_other_enabled_customers(self, db):
		from frappe.query_builder.builder import MariaDB

		db.sql.return_value = []
		with patch("srv_erp.customer.customer.frappe.qb", MariaDB):
			validate_unique_gstin(
				frappe._dict(name="CUST-001", gstin="27AAPFU0939F1ZV", disabled=0)
			)
		query = db.sql.call_args.args[0]
		self.assertIn("`disabled`=0", query)
		self.assertIn("`name`<>'CUST-001'", query)

	@patch("srv_erp.customer.customer.frappe.qb", new_callable=MagicMock)
	def test_blank_gstin_does_not_check_duplicates(self, qb):
		for value in (None, "", "   "):
			validate_unique_gstin(frappe._dict(name="CUST-001", gstin=value))
		qb.from_.assert_not_called()

	@patch("srv_erp.customer.customer.frappe.db", new_callable=MagicMock)
	@patch("srv_erp.customer.customer.frappe.qb", new_callable=MagicMock)
	def test_normalizes_gstin_and_allows_unique_value(self, from_, db):
		db.sql.return_value = []
		doc = frappe._dict(name="CUST-001", gstin=" 27aapfu0939f1zv ")
		validate_unique_gstin(doc)
		self.assertEqual(doc.gstin, "27AAPFU0939F1ZV")

	@patch("srv_erp.customer.customer.frappe.throw", side_effect=frappe.ValidationError)
	@patch("srv_erp.customer.customer.frappe.db", new_callable=MagicMock)
	@patch("srv_erp.customer.customer.frappe.qb", new_callable=MagicMock)
	def test_duplicate_is_rejected(self, from_, db, throw):
		db.sql.return_value = [("CUST-OTHER",)]
		with patch("srv_erp.customer.customer._", side_effect=lambda message: message):
			with self.assertRaises(frappe.ValidationError):
				validate_unique_gstin(frappe._dict(name="CUST-NEW", gstin="27AAPFU0939F1ZV"))
		self.assertIn("already assigned", throw.call_args.args[0])

	def test_customer_save_runs_gstin_validation(self):
		from srv_erp import hooks

		validators = hooks.doc_events["Customer"]["validate"]
		if isinstance(validators, str):
			validators = [validators]
		self.assertEqual(
			validators.count("srv_erp.customer.customer.validate_unique_gstin"), 1
		)
