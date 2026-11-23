import frappe

from srv_erp.smart_dsr.policy import indian_vehicle_number
from srv_erp.smart_dsr.security import SmartDocument


class DSRVehicle(SmartDocument):
	def validate(self):
		super().validate()
		try:
			self.registration_number = indian_vehicle_number(self.registration_number)
		except ValueError as exc:
			frappe.throw(str(exc))
		if self.fuel_type not in ("Petrol", "Diesel", "CNG"):
			frappe.throw("Select Petrol, Diesel or CNG.")
