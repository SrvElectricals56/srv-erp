# Duty OFF with no dealer visits

A duty with no completed dealer visits requires a nonblank reason (up to 2,000 characters) before Duty OFF. Pending visits, active breaks and active night stays must still be resolved first. GPS and odometer evidence requirements remain in place.

The server checks the visit count under the existing account/duty locks. A browser cannot skip this rule. The Duty OFF screen explains the consequence and requires the reason before enabling submission.

When such a duty closes:

- It is marked **No Visits — Excluded**, with the reason retained in salesperson history and administrator details.
- Each recorded expense is marked Reversed. Original amounts and evidence remain available.
- Cash expenses receive an equal and opposite ledger entry linked to the original debit. Expenses paid from personal funds are reversed without inventing a cash credit.
- Existing reversals are not duplicated. Expense reversal, closing balance and duty closure share the same transaction.
- Legacy meal allowances are zeroed with audit events. Fuel entitlement and meal benefits are zero; pending scheduled meals are not allocated during this closure.
- Counted duty time is zero. Counted Duties excludes these records, and the admin overview shows No-visit Duties separately. Historical rows remain visible for audit.
- Actual timestamps, GPS travel, odometer readings, collections and cash custody records are retained. Closing cash includes the expense reversals and carries forward into the next DSR.

The rule applies when a duty is closed. It does not rewrite earlier finalized reports. Excluded duties cannot be reopened or receive new expenses. DSR finalization retains the audit report with zero eligible expense benefits.
