import unittest
from datetime import date

from srv_erp.smart_dsr.time_format import date_field, display_date


class TestShortDates(unittest.TestCase):
	def test_dates_use_two_digit_year(self):
		self.assertEqual(display_date("work_date", "2026-11-20"), "20-11-26")
		self.assertEqual(display_date("insurance_expiry", date(2099, 12, 31)), "31-12-99")

	def test_datetimes_are_converted_to_india_time(self):
		self.assertEqual(display_date("collected_at", "2026-11-20T09:00:00+05:30"), "20-11-26, 09:00 am")
		self.assertEqual(display_date("recorded_at", "2026-12-31T20:00:00Z"), "01-01-27, 01:30 am")

	def test_field_detection_and_missing_values(self):
		for name in ("work_date", "insurance_expiry", "creation", "recorded_at", "posting_time"):
			self.assertTrue(date_field(name))
		self.assertFalse(date_field("record_id"))
		self.assertEqual(display_date("date", None), "—")
		self.assertEqual(display_date("date", "unknown"), "unknown")
