"""Cash issued/returned between duties is anchored to its preceding finalized duty."""

import frappe
from frappe.utils import getdate

from . import api
from .policy import balance, money


def cutoff(as_of):
	return str(getdate(as_of)) + " 23:59:59.999999" if as_of else None


def latest_duty(account, lock=False):
	rows = frappe.db.sql(
		"select name from `tabDSR Duty Session` where account=%s order by work_date desc, creation desc limit 1"
		+ (" for update" if lock else ""),
		account,
		as_dict=True,
	)
	return frappe.get_doc("DSR Duty Session", rows[0].name, for_update=lock) if rows else None


def initial_opening(account, as_of=None, lock=False):
	where = {"account": account, "transaction_type": "Opening", "duty": ["is", "not set"]}
	if as_of:
		where["posting_time"] = ["<=", cutoff(as_of)]
	return frappe.db.get_value("DSR Cash Ledger", where, "amount", for_update=lock)


def direct_pending(account, doc=None, as_of=None):
	"""Home receipts after the last duty snapshot, including their reversals.

	Standalone receipts are only created when there is no mutable duty. Earlier
	receipts are already included in the next duty's opening snapshot.
	"""
	query = """select coalesce(sum(l.amount),0) from `tabDSR Cash Ledger` l
		left join `tabDSR Cash Ledger` original on l.source_type='DSR Cash Ledger'
			and original.name=l.source_name and original.account=l.account
		where l.account=%s and coalesce(l.duty,'')=''
		and (l.source_type='DSR Collection' or
			(l.transaction_type='Reversal' and original.source_type='DSR Collection'
			and coalesce(original.duty,'')=''))"""
	params = [account]
	if doc:
		query += " and l.posting_time > (select creation from `tabDSR Duty Session` where name=%s)"
		params.append(doc.name)
		query += """ and l.posting_time < coalesce((select min(future.creation)
			from `tabDSR Duty Session` future where future.account=l.account
			and future.creation > (select creation from `tabDSR Duty Session` where name=%s)),
			'9999-12-31 23:59:59')"""
		params.append(doc.name)
	if as_of:
		query += " and l.posting_time<=%s"
		params.append(cutoff(as_of))
	return float(money(frappe.db.sql(query, tuple(params))[0][0]))


def pending(account, doc=None, as_of=None, lock=False):
	query = """select amount, transaction_type from `tabDSR Cash Ledger`
		where account=%s and coalesce(duty,'')='' and source_type=%s
		and transaction_type in ('Cash Advance','Cash Handover')"""
	params = [account, "DSR Duty Session" if doc else "User"]
	if doc:
		query += " and source_name=%s"
		params.append(doc.name)
	if as_of:
		query += " and posting_time<=%s"
		params.append(cutoff(as_of))
	rows = frappe.db.sql(query + (" for update" if lock else ""), tuple(params), as_dict=True)
	return {
		"net": float(money(sum(money(row.amount) for row in rows))),
		"added": float(
			money(sum(money(row.amount) for row in rows if row.transaction_type == "Cash Advance"))
		),
	}


def allocated_opening(doc, as_of=None, lock=False):
	query = "select name, amount, transaction_type, source_type, source_name from `tabDSR Cash Ledger` where duty=%s and transaction_type in ('Cash Advance','Cash Handover','Reversal')"
	params = [doc.name]
	if as_of:
		query += " and posting_time<=%s"
		params.append(cutoff(as_of))
	rows = frappe.db.sql(query + (" for update" if lock else ""), tuple(params), as_dict=True)
	funding_names = {row.name for row in rows if row.transaction_type in ("Cash Advance", "Cash Handover")}
	amounts = [
		row.amount
		for row in rows
		if row.transaction_type in ("Cash Advance", "Cash Handover")
		or (row.source_type == "DSR Cash Ledger" and row.source_name in funding_names)
	]
	return float(balance(doc.opening_balance, amounts))


def balances(account, doc=None, as_of=None, lock=False):
	if doc and doc.status != "Finalized":
		return {
			"opening_balance": allocated_opening(doc, as_of, lock),
			"closing_balance": float(
				balance(doc.opening_balance, api.cash_movements(doc, as_of=cutoff(as_of), lock=lock))
			),
		}
	base = doc.closing_balance if doc else initial_opening(account, as_of, lock)
	if doc and as_of:
		base = float(balance(doc.opening_balance, api.cash_movements(doc, as_of=cutoff(as_of), lock=lock)))
	direct = direct_pending(account, doc, as_of)
	if base is None and not direct:
		return {"opening_balance": None, "closing_balance": None}
	base = base or 0
	movements = pending(account, doc, as_of, lock)
	return {
		"opening_balance": float(balance(base, [movements["net"], direct])),
		"closing_balance": float(balance(base, [movements["net"], direct])),
	}


def next_opening(account, previous=None, initial=None):
	base = previous.closing_balance if previous else initial
	return float(
		balance(base, [pending(account, previous, lock=True)["net"], direct_pending(account, previous)])
	)
