# Manual overdue register

Open `/app/overdues` in Desk. Accounts Users, Accounts Managers and Administrator can use the register. Dealer and Company permissions still apply.

Select **Add Overdue**, choose a dealer, and enter the record date, due date, amount due and any amount already received. A bill reference, salesperson and remarks are optional. For later payments, use **Add Received Amount**. Enter the dealer, amount, received date, payment reference and remarks. The payment is applied to the oldest unpaid entries first. The page then shows the selected dealer’s updated balance. **Receipt History** opens the saved receipt records and allocation details. Retries reuse the same request key to prevent a second deduction. The remaining balance is the amount due minus the amount received. Fully paid entries remain visible. Use **Cancelled** for an incorrect record to exclude it from totals while keeping its change history.

Every balance comes from a Dealer Overdue record for SRV Electricals. Dues are entered manually. Smart DSR collections create receipts linked to their source collection, reduce the oldest unpaid manual entries, and preserve any amount above the remaining balance as unapplied. Reversing a collection restores its allocated amounts. Source links and request keys prevent duplicate deductions. A collection applies only to dues that already existed when it was recorded.

Salespersons can also use **Collect Money** on Home without an active duty. Select an allocated dealer, amount and payment method (Cash, UPI, Bank Transfer or Cheque). These receipts appear under **Home / Direct** in Collections and reduce the dealer’s manual dues. Collections outside an unfinished duty credit the account balance and carry into the next duty's opening once; they do not create a duty or change finalized DSRs. Cheque and other noncash payments require a transaction reference. Administrator reversals restore dues and debit the current balance.

Filter by dealer, territory, salesperson, balance status, minimum balance or age. Search matches dealer names, entry numbers and references. Switch between dealer totals and individual entries. The ageing date determines which entries are included and how many days overdue they are. Received amounts are the currently entered totals, so the ageing date cannot reproduce historical payment balances.

The standard Page and Dealer Overdue DocType are installed by site migration. Run the following checks from the bench directory:

```sh
PYTHONPATH=apps/frappe:apps/erpnext:apps/srv_erp env/bin/python -m unittest srv_erp.tests.test_overdues -v
node apps/srv_erp/ops/check_overdues.cjs
```

The browser check requires Playwright and Chromium. The `srv_erp.tests.test_overdues.live_smoke` bench test exercises creation, retry, updates and cancellation in a transaction that is rolled back.
