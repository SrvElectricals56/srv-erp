"""Expense receipts are required, private, validated, and not duplicated on retry."""

import base64
import io
import unittest
from datetime import datetime
from unittest.mock import Mock, patch

import frappe
from PIL import Image

from srv_erp.smart_dsr import api


class TestExpenseReceipts(unittest.TestCase):
	def setUp(self):
		for name, value in (
			("local", frappe._dict(flags=frappe._dict(in_test=False))),
			("session", frappe._dict(user="user")),
		):
			mock = patch.object(frappe, name, value)
			mock.start()
			self.addCleanup(mock.stop)
		self.cache = Mock()
		self.cache.get_value.return_value = {
			"duty": "duty",
			"account": "user",
			"request_key": "expense-request",
		}
		mock = patch.object(frappe, "cache", return_value=self.cache)
		mock.start()
		self.addCleanup(mock.stop)
		mock = patch.object(frappe, "throw", side_effect=self.throw)
		mock.start()
		self.addCleanup(mock.stop)

	@staticmethod
	def throw(message, exc=frappe.ValidationError, **kwargs):
		raise exc(message)

	def test_receipt_required_and_upload_is_private_without_changing_balance(self):
		image = io.BytesIO()
		Image.new("RGB", (120, 120), "white").save(image, format="JPEG")
		for upload in (
			None,
			{
				"filename": "receipt.jpg",
				"content": base64.b64encode(image.getvalue()).decode(),
				"challenge": "token",
			},
		):
			with self.subTest(upload=bool(upload)):
				doc = frappe._dict(name="duty", account="user", status="Active")
				row = frappe._dict(name="expense", doctype="DSR Expense Record")

				def insert(dt, **values):
					row.update(values)
					return row

				with (
					patch.object(api, "active", return_value=doc),
					patch.object(api, "repeated", return_value=None),
					patch.object(api, "insert", side_effect=insert),
					patch.object(api, "now_datetime", return_value=datetime(2026, 11, 16, 10)),
					patch.object(api, "cash_balance", return_value=1000),
					patch.object(api, "ledger") as ledger,
					patch.object(frappe, "get_doc", return_value=row),
					patch(
						"frappe.utils.file_manager.save_file",
						return_value=frappe._dict(file_url="/private/files/receipt.jpg"),
					) as save_file,
					patch.object(api, "save"),
				):
					if not upload:
						with self.assertRaisesRegex(frappe.ValidationError, "receipt is required"):
							api.record_expense("duty", "Fuel (CNG/Petrol/Diesel)", 100, 1, "expense-request")
						ledger.assert_not_called()
						save_file.assert_not_called()
						continue
					result = api.record_expense(
						"duty", "Fuel (CNG/Petrol/Diesel)", 100, 1, "expense-request", receipt_file=upload
					)
					self.assertEqual(result, {"name": "expense", "balance": 1000})
					self.assertEqual(row.account, "user")
					ledger.assert_not_called()
					self.assertFalse(row.paid_from_cash)
					if upload:
						self.assertEqual(save_file.call_args.kwargs, {"is_private": 1, "df": "receipt"})
						self.assertEqual(row.receipt, "/private/files/receipt.jpg")
					else:
						save_file.assert_not_called()
						self.assertIsNone(row.receipt)

	def test_retry_does_not_create_or_upload_again(self):
		with (
			patch.object(api, "active", return_value=frappe._dict(account="user")),
			patch.object(api, "repeated", return_value=frappe._dict(name="existing")),
			patch.object(api, "cash_balance", return_value=900),
			patch.object(api, "expense_receipt") as upload,
			patch.object(api, "record_expense_document") as record,
		):
			self.assertEqual(
				api.record_expense(
					"duty", "Fuel (CNG/Petrol/Diesel)", 100, 1, "same-request", receipt_file={"bad": "file"}
				),
				{"name": "existing", "balance": 900},
			)
			upload.assert_not_called()
			record.assert_not_called()

	def test_invalid_receipt_does_not_post_expense(self):
		with (
			patch.object(api, "active", return_value=frappe._dict(account="user")),
			patch.object(api, "repeated", return_value=None),
			patch.object(api, "record_expense_document") as record,
		):
			for value in (
				{"filename": "bad.pdf", "content": "not-base64"},
				{"filename": "receipt.pdf", "content": base64.b64encode(b"not a PDF").decode()},
				{"filename": "file.exe", "content": base64.b64encode(b"program").decode()},
			):
				with self.subTest(value=value), self.assertRaises(frappe.ValidationError):
					api.record_expense(
						"duty", "Fuel (CNG/Petrol/Diesel)", 100, 1, "expense-key", receipt_file=value
					)
			record.assert_not_called()

	def test_inaccessible_or_inactive_duty_cannot_upload(self):
		with (
			patch.object(api, "active", side_effect=frappe.PermissionError),
			patch.object(api, "expense_receipt") as upload,
		):
			with self.assertRaises(frappe.PermissionError):
				api.record_expense(
					"other-duty",
					"Fuel (CNG/Petrol/Diesel)",
					100,
					1,
					"expense-key",
					receipt_file={"file": "data"},
				)
			upload.assert_not_called()

	def test_manual_expense_cannot_claim_automatic_meal_identifier(self):
		with (
			patch.object(api, "active", return_value=frappe._dict(account="user")),
			patch.object(api, "record_expense_document") as record,
		):
			for category, request_key, error in (
				("Fuel (CNG/Petrol/Diesel)", "automatic-meal:2026-11-16:Breakfast", frappe.PermissionError),
				("Breakfast", "manual-meal-key", frappe.ValidationError),
			):
				with self.subTest(category=category), self.assertRaises(error):
					api.record_expense("duty", category, 1, 1, request_key)
			record.assert_not_called()

	def test_receipt_camera_challenge_is_bound_to_expense_and_owner(self):
		with patch.object(api, "active", return_value=frappe._dict(name="duty", account="user")):
			token = api.receipt_camera_challenge("duty", "expense-request")
			self.cache.set_value.assert_called_once_with(
				"dsr-receipt:" + token,
				{"duty": "duty", "account": "user", "request_key": "expense-request"},
				expires_in_sec=120,
			)

	def test_file_links_and_pdf_cannot_bypass_live_camera(self):
		with (
			patch.object(api, "active", return_value=frappe._dict(name="duty", account="user")),
			patch.object(api, "repeated", return_value=None),
			patch.object(api, "record_expense_document") as record,
		):
			with self.assertRaises(frappe.PermissionError):
				api.record_expense(
					"duty",
					"Fuel (CNG/Petrol/Diesel)",
					100,
					1,
					"expense-request",
					receipt="/private/files/old.jpg",
				)
			with self.assertRaises(frappe.ValidationError):
				api.record_expense(
					"duty",
					"Fuel (CNG/Petrol/Diesel)",
					100,
					1,
					"expense-request",
					receipt_file={"challenge": "token", "content": base64.b64encode(b"%PDF-1.4").decode()},
				)
			record.assert_not_called()

	def test_expired_or_mismatched_receipt_challenge_does_not_post(self):
		with (
			patch.object(api, "active", return_value=frappe._dict(name="duty", account="user")),
			patch.object(api, "repeated", return_value=None),
			patch.object(api, "record_expense_document") as record,
		):
			for known in (
				None,
				{"duty": "another-duty", "account": "user", "request_key": "expense-request"},
				{"duty": "duty", "account": "other-user", "request_key": "expense-request"},
				{"duty": "duty", "account": "user", "request_key": "different-request"},
			):
				self.cache.get_value.return_value = known
				with self.subTest(known=known), self.assertRaises(frappe.ValidationError):
					api.record_expense(
						"duty",
						"Fuel (CNG/Petrol/Diesel)",
						100,
						1,
						"expense-request",
						receipt_file={"challenge": "token", "content": "photo"},
					)
			record.assert_not_called()
