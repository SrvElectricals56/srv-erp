# Smart DSR Administrator Control Panel

The local site now provides **`/smart-dsr/admin`** inside `srv_erp`, alongside the existing salesperson website `/smart-dsr`. The panel uses live Frappe records and transactional service APIs. It is not a separate site or a static dashboard.

## Access and setup

Sign in using the existing Frappe login at `/login?redirect-to=/smart-dsr/admin`.

| Account / role | Control-panel access |
| --- | --- |
| Actual Frappe Administrator | All panel features; no Employee or Sales Person mapping required |
| Smart DSR Administrator | Read DSR records, notes, eligible metadata, explicit evidence exceptions and same-day draft reopening |
| Smart DSR Financial Administrator | Administrative read access plus permitted opening/cash corrections and financial workflows |
| Ordinary salesperson / other User / Guest | Denied at both page and API levels |

Both custom roles were created **without assigning them to any ordinary User**. Administrator can explicitly assign them through standard User role management. Normal ERPNext Payment Entry create/submit/cancel permissions are still needed for accounting posting or cancellation; this panel does not grant Accounts Manager or bypass accounting workflows.

Only the actual Administrator can manage optional Employee links, change the two permitted salesperson roles, or deactivate/reactivate Smart DSR access. No arbitrary privileged-role assignment is exposed. User access uses the new read-only Custom Field `User.smart_dsr_disabled`, protected before validation/save. A User cannot reactivate their own access by changing a document payload.

The earlier User-based login policy is preserved: Employees and Sales Person records are **optional for entering the salesperson website**. Employee management supplies administrative HR mapping, status and duplicate diagnostics. It does not create Employees or make Employee mapping mandatory again. Dashboard “Total Salespersons” counts enabled Users eligible for Smart DSR under that policy, not HR headcount.

## Completed sections

1. **Overview:** ten real-data metrics, date/User filters, search, and paginated salesperson rows with optional Employee identity, duty, opening/live closing cash, verified distance, elapsed duty time, visits and collections. The All Dates filter applies to the totals as well as the table. Pending review includes closed Smart DSRs and draft legacy DSRs.
2. **Salespersons:** searchable User and Employee views, optional existing Active Employee linking, active/unique validation, territory display, role changes limited to Sales User/Sales Rapl, access activation/deactivation, and duty/DSR history. Existing and unmapped records are retained.
3. **Opening Balances:** first manual initialization by User, previous finalized closing, current cash, advances, handovers, authorized adjustments/reversals, reasons and history. Opening initialization remains one-time. Existing openings are never overwritten.
4. **Duty Records:** vehicle/fuel/date/times, duration, verified GPS distance, original start/last-before-OFF GPS evidence, accuracy/timestamps/status and four vehicle-document declarations. Eligible vehicle/start-label corrections require a reason; raw GPS and original declarations are not editable. Starting and ending samples are shown with their actual capture times; the last recorded point is not represented as an invented endpoint.
5. **Party Visits:** User/dealer/date/duty/number/status filters; arrival/departure, travel verification, original private photos, collections, orders, reviews and details. Open metadata/reviews and eligible order associations can be corrected. Submitted visits and finalized reports receive an explicit correction record rather than an original-evidence overwrite. GPS/photo exceptions require explicit administrative reasons and audit records.
6. **Collections:** allocations, method, amount, original visit, posting reference and status. Eligible unposted metadata/allocations can be corrected. Posting uses the existing Payment Entry workflow. Amount/method changes use atomic reversal-and-replacement, preserving the original record and ledger. Posted corrections first use standard ERPNext cancellation with the actor's cancellation permission. An ERPNext Payment Entry link is provided.
7. **Expenses:** original expense rows and actual cash impact, with fuel/meal/other/cash totals. Eligible notes can be corrected. Amount/category/cash changes use reversal-and-replacement. Fuel entitlements and cash fuel disbursements are not double counted. No salesperson expense approval workflow was added.
8. **DSR Records:** legacy and Smart DSR lists, linked duty details, checklist, visits, orders, collections, reviews, GPS evidence, cash, reimbursements and ledger. Supports audit notes, correction requests, recalculation of open/closed reports, authorized closed-report finalization, and same-day closed/unsubmitted draft reopening. Reopening leaves original GPS evidence intact and excludes the intervening OFF period from elapsed duty time.
9. **Reports:** Daily/Weekly/Monthly/Quarterly salesperson records and period totals, Dealer Visits, Collections, Outstanding Dues, Expenses, Cash Balances and GPS Exceptions. Results use server-side filtering/pagination. Outstanding date filters apply to invoice due dates; cash reports use the selected end date as an as-of ledger cutoff. PDF and Excel exports enforce permissions, escape spreadsheet formula strings and limit exports to 5,000 filtered rows. Read-only reports do not take financial row locks during PDF generation.
10. **Audit Logs:** actor, affected User/Employee, source record, action, original/updated values, reason, server timestamp, outcome and linked financial transaction. Audit history is append-only; ordinary document saves/deletes are rejected even for Administrator.

## Financial and evidence integrity

Every panel mutation creates an administrative audit record. Employee linking also creates a record specifically identifying the affected Employee and old/new User relationship. Request keys are unique per actor and make financial retries idempotent. Existing User-row locks serialize financial writes.

Financial correction services reuse the existing cash ledger, amount checks, allocation reservations, Payment Entry creation and ERPNext cancellation logic. They never edit GL rows or submitted Payment Entry amounts. A replacement collection is recorded but does not reduce invoice outstanding until Accounts posts it. Cancellation failures roll back the entire correction transaction.

Finalized cash and submitted evidence remain protected. Corrections to finalized balances belong in the next eligible open DSR/normal Accounts reconciliation workflow. Finalized DSRs cannot be directly reopened. Submitted visit corrections are preserved as review records; they do not silently modify the original photo or GPS evidence. Historical reports and original Employee fields have not been deleted or renamed.

## Data model and source inventory

New DocType: **DSR Admin Audit**. New Custom Field: **User.smart_dsr_disabled**. New unassigned roles: **Smart DSR Administrator**, **Smart DSR Financial Administrator**. Existing financial/business DocTypes are reused.

Created:

- `srv_erp/smart_dsr/admin.py`
- `srv_erp/smart_dsr/admin_permissions.py`
- `srv_erp/public/smart_dsr/admin.js`
- `srv_erp/public/smart_dsr/admin.css`
- `srv_erp/www/smart-dsr-admin.html`
- `srv_erp/www/smart_dsr_admin.py`
- `srv_erp/srv_erp/doctype/dsr_admin_audit/__init__.py`
- `srv_erp/srv_erp/doctype/dsr_admin_audit/dsr_admin_audit.py`
- `srv_erp/srv_erp/doctype/dsr_admin_audit/dsr_admin_audit.json`
- `srv_erp/tests/test_smart_dsr_admin.py`
- `ops/check_smart_dsr_admin.cjs`
- `docs/smart-dsr/administrator-panel.md`

Modified for this panel:

- `srv_erp/hooks.py`: protected website alias, User guards and audit permissions.
- `srv_erp/smart_dsr/setup.py`: additive roles, audit schema, User field and indexes.
- `srv_erp/smart_dsr/security.py`: explicit admin read scope and account-access deactivation.
- `srv_erp/smart_dsr/api.py`: explicit financial-admin authorization, shared financial/finalization helpers, reopen-aware elapsed duty time and admin-link capability.
- `srv_erp/smart_dsr/testing.py`: register administrator regressions.
- `srv_erp/public/smart_dsr/app.js`: authorized panel link and correct elapsed time after reopening.
- `srv_erp/www/smart-dsr.html`: refreshed asset version.
- `docs/smart-dsr/README.md`: administrator-panel handoff link.

No application files or business records were removed for this task. Unrelated pre-existing production/configuration changes were preserved.

## APIs and routes

New API prefix: `/api/method/srv_erp.smart_dsr.admin.`

- Read: `bootstrap`, `overview`, `list_records`, `details`, `balance_details`, `report`, `export_report`.
- Administrative mutations: `manage_user`, `opening_balance`, `cash_adjustment`, `correct_metadata`, `post_payment`, `reverse_financial`, `replace_financial`, `dsr_action`, `link_order`, `evidence_exception`.

Every endpoint checks the authenticated actor. Mutations accept POST only, use existing session/CSRF protection, validate allowed fields and require reasons. Internal shared services are not whitelisted for remote invocation.

Website: `/smart-dsr/admin`, mapped to the protected `smart-dsr-admin` template. The direct `/smart-dsr-admin` template route uses the same permission guard. Sidebar sections are URL hashes under the administrator route. `/smart-dsr` remains available and shows a panel link only for authorized actors.

## Backup and migrations

Verified site backup set:

`sites/local/private/backups/20261114_130104-local-*`

It contains database, configuration, public and private attachment archives. Gzip/tar integrity checks passed. Current source was archived at `/workspace/development/dsr-backup/before-admin-panel.tgz`.

`bench --site local execute srv_erp.smart_dsr.setup.execute` passed and applied the required additive panel schema, roles, permissions, field and indexes. Cache clearing and builds passed.

A full migration was not rerun through the unrelated inventory patch. Read-only readiness checks confirmed that `srv_erp.patches.convert_box_group_uoms_to_bag` is still unapplied and **Item CB 312 still has different conversion factors: Box 120, Bag 90**. No conversion factors, patch-log entries or inventory data were changed to bypass that decision. Full-bench migration remains subject to resolving that existing inventory issue.

## Verification

- Full rollback-only salesperson/administrator regression run: **102 tests passed**.
- Final administrator suite at that checkpoint: **19 tests passed**.
- Follow-up read/report/mapping checks: **3 passed**; Employee-ID search and All Dates aggregation check: **1 passed**.
- Additional explicit evidence-exception and unauthorized-API checks: **2 passed**. The source now contains 20 administrator tests; the additional exception test was checked separately after the 19-test run.
- Financial integration tests posted and cancelled actual ERPNext Payment Entries within rollback-only fixtures; original cash, reversals/replacements, allocation validation, immutable audit records, optional Employee linking, User access guards, private photo permissions, reopening/finalization and period reports passed.
- PDF and Excel generation returned valid PDF/XLSX bytes in backend tests.
- Initial/final asset builds, Python compilation, JavaScript syntax and whitespace checks passed.
- Live unauthenticated `/smart-dsr/admin`: **HTTP 403**. Live unauthenticated admin bootstrap API: **HTTP 403**. Existing `/smart-dsr`: **HTTP 200**.
- Actual local Administrator bootstrap passed without requiring an Employee mapping. Readiness verified both roles, the User field, audit DocType, route and User save guards.
- Chromium UI checks passed all ten sections, ten metrics, filters/tables, balance/replacement forms, Employee view and no page overflow at 1440px/390px. Screenshots were inspected under `/tmp/smart-dsr-admin-screenshots/`.

Browser UI checks use isolated authenticated API fixtures. No real salesperson browser account/password or production financial data was used for mutations. Backend fixtures and generated evidence files are rolled back/cleaned. No full 105-test combined run was repeated after the final focused checks.

Evidence files: `/tmp/smart-dsr-admin-full-tests.log`, `/tmp/smart-dsr-admin-final-tests.log`, `/tmp/smart-dsr-admin-read-final.log`, `/tmp/smart-dsr-admin-filter-final.log`, `/tmp/smart-dsr-admin-exception-tests.log`, `/tmp/smart-dsr-admin-browser-final.log`, `/tmp/smart-dsr-admin-build-final.log`, `/tmp/smart-dsr-admin-readiness.json`.

## Operational limits

- User suggestions are limited to 200; paginated tables/search cover the full roster. Related detail previews show up to 100 records (User history previews 30); use the main filtered, paginated sections for larger histories.
- PDF requires the installed wkhtmltopdf runtime. Exports are capped at 5,000 rows; narrow filters for larger datasets.
- Period reports show daily duty rows within the selected period and period totals, rather than inventing a second accounting dataset.
- A report with no identifiable historical User retains its original evidence; ownership is not guessed. Such financial corrections need administrative mapping review.
- GPS history contains last-known fixes, not guaranteed exact road travel or uninterrupted background tracking. Ending samples are displayed with their capture timestamp; missing GPS is never fabricated.
- Finalized records require correction records/next-period accounting adjustments; direct finalized reopening, original photo replacement and direct GL editing are deliberately unavailable.
- Financial administrators still need normal ERPNext accounting permissions and configured accounts for posting/cancellation.

## Run and verify

From `/workspace/development/frappe-bench-v15`:

```sh
bench --site local execute srv_erp.smart_dsr.setup.execute
bench build --app srv_erp
bench --site local clear-cache
bench --site local execute srv_erp.smart_dsr.testing.run
bench --site local serve --port 8001
```

Open `http://127.0.0.1:8001/smart-dsr/admin` as Administrator. Reuse the already-running development server; do not start a second process on its port.

Browser fixture checks, from `apps/srv_erp` with the tools already installed in this environment:

```sh
LD_LIBRARY_PATH=/tmp/smart-dsr-libs/extracted/usr/lib/x86_64-linux-gnu NODE_PATH=/tmp/smart-dsr-browser/node_modules node ops/check_smart_dsr_admin.cjs
```

After the inventory owner resolves the Box/Bag conflict, the ordinary complete migration command is `bench --site local migrate --skip-search-index`. The panel's required additive setup has already succeeded independently.

Final-source smoke verification also passed the live-data dashboard/filter/report test and the explicit evidence-exception workflow after the last refinements (`/tmp/smart-dsr-admin-final-verification.log`, 2 tests). The final browser run passed again. No test or verification server replaced or stopped the user's existing development server.
