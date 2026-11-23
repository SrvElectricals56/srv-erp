"""Paged party/product quantities over permission-checked, submitted sales documents."""

import frappe
from frappe.utils import add_months, cint, getdate

from .home_collections import account, assigned_salesperson

SOURCES = {
	"orders": ("Sales Order", "Sales Order Item", "transaction_date"),
	"invoices": ("Sales Invoice", "Sales Invoice Item", "posting_date"),
}


def parties():
	sales = assigned_salesperson(account())
	return frappe.get_list(
		"Customer",
		filters={"sales_person": sales},
		fields=["name", "customer_name", "disabled"],
		order_by="customer_name asc, name asc",
		limit_page_length=0,
	)


def permitted_query(source, customers, from_date="", to_date="", company=""):
	if source not in SOURCES:
		frappe.throw("Invalid sales source.")
	doctype, childtype, datefield = SOURCES[source]
	if not frappe.has_permission(doctype, "read"):
		frappe.throw("You do not have permission to read this sales source.", frappe.PermissionError)
	filters = {"docstatus": 1, "customer": ["in", customers]}
	if from_date and to_date:
		filters[datefield] = ["between", [getdate(from_date), getdate(to_date)]]
	elif from_date:
		filters[datefield] = [">=", getdate(from_date)]
	elif to_date:
		filters[datefield] = ["<=", getdate(to_date)]
	if company:
		filters["company"] = company
	# Build Frappe's full role/user/permission-hook query without loading every document.
	query = frappe.get_list(
		doctype,
		fields=["name"],
		filters=filters,
		order_by="name",
		limit_page_length=0,
		distinct=True,
		run=False,
	)
	return str(query).strip().rstrip(";"), doctype, childtype, datefield


def interval_dates(interval, period=""):
	import re
	from datetime import date, timedelta

	months = {"monthly": 1, "quarterly": 3, "half-yearly": 6, "yearly": 12}.get(interval)
	if not months:
		frappe.throw("Select a valid interval.")
	period = period or str(getdate())[:7]
	if not re.fullmatch(r"\d{4}-\d{2}", str(period)):
		frappe.throw("Select a valid period month.")
	anchor = getdate(str(period) + "-01")
	start = date(anchor.year, ((anchor.month - 1) // months) * months + 1, 1)
	return str(start), str(add_months(start, months) - timedelta(days=1))


@frappe.whitelist()
def options():
	customers = parties()
	sources = [
		{"value": key, "label": doctype + "s"}
		for key, (doctype, _, _) in SOURCES.items()
		if frappe.has_permission(doctype, "read")
	]
	return {"customers": customers, "sources": sources, "companies": [], "today": str(getdate())}


@frappe.whitelist()
def report(
	source="orders",
	view="items",
	search="",
	customer="",
	item_code="",
	from_date="",
	to_date="",
	company="",
	start=0,
	interval="",
	period="",
):
	customers = parties()
	if interval:
		from_date, to_date = interval_dates(interval, period)
	if view not in ("items", "purchases"):
		frappe.throw("Invalid report view.")
	if from_date and to_date and getdate(from_date) > getdate(to_date):
		frappe.throw("To Date must be on or after From Date.")
	allowed = {row.name: row for row in customers}
	if customer and customer not in allowed:
		frappe.throw("Select a customer allocated to your Sales Person.", frappe.PermissionError)
	if not allowed:
		return {
			"rows": [],
			"count": 0,
			"metrics": {"parties": 0, "products": 0, "documents": 0},
			"quantities": [],
			"page_size": 50,
		}
	query, doctype, childtype, datefield = permitted_query(
		source, [customer] if customer else list(allowed), from_date, to_date, company
	)
	# Table/column names come only from SOURCES. User-entered values remain bound parameters.
	joined = f" from ({query}) permitted inner join `tab{doctype}` sale on sale.name=permitted.name inner join `tab{childtype}` line on line.parent=sale.name and line.parenttype=%s and line.parentfield='items'"
	where, params = ["coalesce(line.item_code,'')!=''"], [doctype]
	if item_code:
		where.append("line.item_code=%s")
		params.append(item_code)
	if str(search).strip():
		where.append(
			"("
			+ " or ".join(
				f"coalesce({field},'') like %s"
				for field in (
					"sale.customer",
					"sale.customer_name",
					"line.item_code",
					"line.item_name",
					"sale.name",
				)
			)
			+ ")"
		)
		params.extend(["%" + str(search).strip()[:100] + "%"] * 5)
	joined += " where " + " and ".join(where)
	metrics = frappe.db.sql(
		"select count(distinct sale.customer) as parties, count(distinct line.item_code) as products, count(distinct sale.name) as documents"
		+ joined,
		tuple(params),
		as_dict=True,
	)[0]
	quantities = frappe.db.sql(
		"select line.stock_uom as uom, sum(line.stock_qty) as qty"
		+ joined
		+ " group by line.stock_uom order by line.stock_uom",
		tuple(params),
		as_dict=True,
	)
	grouping = " group by sale.customer, line.item_code, line.stock_uom"
	if view == "items":
		count = frappe.db.sql(
			"select count(*) from (select sale.customer, line.item_code, line.stock_uom"
			+ joined
			+ grouping
			+ ") grouped_items",
			tuple(params),
		)[0][0]
		fields = f"""select sale.customer, max(sale.customer_name) as customer_name, line.item_code,
			max(line.item_name) as item_name, line.stock_uom as uom, sum(line.stock_qty) as qty,
			count(distinct sale.name) as documents, min(sale.{datefield}) as first_date, max(sale.{datefield}) as last_date"""
		ending = (
			grouping
			+ " order by customer_name asc, sale.customer asc, line.stock_uom asc, qty desc, line.item_code asc"
		)
	else:
		count = frappe.db.sql("select count(*)" + joined, tuple(params))[0][0]
		is_return = "sale.is_return" if source == "invoices" else "0"
		fields = f"""select sale.name as document, sale.customer, sale.customer_name, sale.company,
			sale.{datefield} as date, line.name as line_name, line.item_code, line.item_name,
			line.qty, line.uom, line.stock_qty, line.stock_uom, {is_return} as is_return"""
		ending = f" order by sale.{datefield} desc, sale.name desc, line.idx asc"
	rows = frappe.db.sql(
		fields + joined + ending + " limit %s offset %s",
		tuple([*params, 50, max(0, cint(start))]),
		as_dict=True,
	)
	return {
		"rows": rows,
		"count": cint(count),
		"metrics": metrics,
		"quantities": quantities,
		"page_size": 50,
		"doctype": doctype,
	}
