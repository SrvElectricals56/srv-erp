"""Indian registration format checks; these do not verify VAHAN ownership."""

import unittest
from unittest.mock import patch

import frappe

from srv_erp.smart_dsr import api
from srv_erp.smart_dsr.policy import indian_vehicle_number


class TestVehicleNumber(unittest.TestCase):
	def test_supported_registration_formats(self):
		for value, expected in {
			"PB31AB1234": "PB31AB1234",
			"pb 31 ab 1234": "PB31AB1234",
			"PB-31-AB-1234": "PB31AB1234",
			"DL1CAA1234": "DL1CAA1234",
			"MH12DE1433": "MH12DE1433",
			"PB31A1": "PB31A0001",
			"PB311234": "PB311234",
			"TG09AB1234": "TG09AB1234",
			"TS09AB1234": "TS09AB1234",
			"22 BH 1234 AA": "22BH1234AA",
			"21BH0001A": "21BH0001A",
		}.items():
			with self.subTest(value=value):
				self.assertEqual(indian_vehicle_number(value), expected)

	def test_invalid_registration_rejected(self):
		for value in (
			None,
			"",
			"123456",
			"TEST01",
			"ZZ31AB1234",
			"PB00AB1234",
			"PB31AB0000",
			"PB31AB12345",
			"PB31ABCD1234",
			"PB31AB12@4",
			"20BH1234AA",
			"22BH0000AA",
			"22BH1234IO",
			"PB३१AB1234",
		):
			with self.subTest(value=value):
				with self.assertRaises(ValueError):
					indian_vehicle_number(value)

	def test_api_rejects_invalid_plate_before_creating_duty(self):
		def reject(message, *args, **kwargs):
			raise frappe.ValidationError(message)

		with (
			patch.object(api, "identity", return_value="user@example.invalid"),
			patch.object(api, "bootstrap"),
			patch.object(api, "settings"),
			patch.object(frappe, "throw", side_effect=reject),
		):
			with self.assertRaisesRegex(frappe.ValidationError, "Indian vehicle number"):
				api.duty_on(
					"TEST01",
					"CNG",
					"Current Location",
					{},
					"test-vehicle-key",
					documents=dict(insurance=True, puc=True, rc=True, fastag=True),
				)


class TestSimpleVehicleForm(unittest.TestCase):
	def test_simple_form_needs_no_type_make_model_or_document_numbers(self):
		values = api.vehicle_values(
			dict(
				registration_number="pb 31 ab 1234",
				fuel_type="Diesel",
				insurance_available="1",
				puc_available="1",
				rc_available="1",
				fastag_available="0",
			)
		)
		self.assertEqual(
			values,
			dict(
				registration_number="PB31AB1234",
				fuel_type="Diesel",
				insurance_available=1,
				puc_available=1,
				rc_available=1,
				fastag_available=0,
			),
		)
		self.assertEqual(api.vehicle_validation_error(values), "")
		values["insurance_available"] = 0
		self.assertIn("Insurance is not available", api.vehicle_validation_error(values))

	def test_expiry_is_optional_but_expired_documents_are_rejected(self):
		from datetime import date

		vehicle = dict(
			insurance_available=1, puc_available=1, rc_available=1, insurance_expiry=date(2000, 1, 1)
		)
		with patch.object(api, "getdate", side_effect=lambda value=None: value or date(2026, 11, 16)):
			self.assertIn("Insurance is expired", api.vehicle_validation_error(vehicle))

	def test_legacy_details_populate_availability(self):
		values = api.vehicle_values(
			dict(
				registration_number="PB31AB1234",
				fuel_type="CNG",
				insurance_number="INS",
				puc_number="PUC",
				rc_number="RC",
				fastag_details="TAG",
			)
		)
		for key in ("insurance", "puc", "rc", "fastag"):
			self.assertEqual(values[key + "_available"], 1)
