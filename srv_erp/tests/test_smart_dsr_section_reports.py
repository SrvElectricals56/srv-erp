"""Section reports use authorized record queries and retain section filters."""

import unittest
from unittest.mock import patch

from srv_erp.smart_dsr import admin


class TestSectionReports(unittest.TestCase):
	def test_sections_use_matching_record_queries(self):
		sections = {
			"Salespersons": "people",
			"Opening Balances": "balances",
			"Vehicles": "vehicles",
			"Duty Records": "duties",
			"Party Visits": "visits",
			"Collections": "collections",
			"Expenses": "expenses",
			"DSR Records": "dsrs",
		}
		filters = {"search": "example", "account": "sales@test", "all_dates": True}
		for label, dataset in sections.items():
			with (
				self.subTest(report=label),
				patch.object(admin, "require_admin") as authorize,
				patch.object(admin, "list_records", return_value={"rows": [], "total": 42}) as query,
				patch.object(admin, "overview", return_value={}),
			):
				result = admin.report.__wrapped__(label, filters, page=2, page_size=20)
				authorize.assert_called_once()
				query.assert_called_once_with(dataset, filters, 2, 20)
				self.assertEqual(result["dataset"], dataset)
				self.assertEqual(result["total"], 42)
				self.assertEqual(result["filters"], filters)

	def test_dates_and_section_filters_are_preserved(self):
		filters = {
			"from_date": "2026-11-01",
			"to_date": "2026-11-20",
			"customer": "DEALER-1",
			"payment_method": "Cash",
		}
		dataset, actual = admin.report_filters("Collections", filters)
		self.assertEqual(dataset, "collections")
		self.assertEqual(actual, filters)
		self.assertIsNot(actual, filters)
