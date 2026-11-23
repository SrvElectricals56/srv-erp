Administrator Control Panel: [implementation report](administrator-panel.md), website `/smart-dsr/admin`. See the linked report for access, features, migrations, tests and startup commands.

> Updated login policy: all enabled Users can now enter Smart DSR using their existing email/password. Employee and salesperson-role requirements below are historical and superseded. See [User login and ownership](user-login.md).

# Smart DSR — Minimal Business redesign

The existing Frappe v15 site `local` serves `/smart-dsr`. No site or ERPNext installation was created. Existing authentication, mapped Employee/Sales Person identity, Customer permissions, accounting workflows and historical DSR records remain in use.

The primary screen is now Header → Duty ON/OFF → Opening Balance / Closing Balance / Total Distance / Total Time → Party Visits → Add Visit. There is no Dashboard, Available Cash card, Collections summary card, journey page, bottom mobile navigation, inline order builder, odometer form, break UI or native client in the active application.

## Safety and audit

Verified backup set: `sites/local/private/backups/20261114_110522-local-*`, including database, site configuration, public and private attachments. Gzip was read to EOF and both tar archives were opened successfully. This is an archive-integrity check; no restore into another database was attempted.

Code safety branch: `safety/smart-dsr-before-redesign-20261114`, commit `629aeaf66e3e0e954b45089eef5e1aebbd351e0e`. It preserves the complete previous working state without changing the active index. Additional source archive, app Git versions and schema/configuration inventory are under `/workspace/development/dsr-backup/20261114-redesign/`. Treat backups as private site data.

The prior implementation was uncommitted on top of `08a638d`. Existing dirty production service/updates, project configuration, DSR financial protections and DSR Lead changes were preserved. No reset, table drop, historical field removal, document purge, invoice/customer edit or permission-policy rewrite was performed. Additive schema synchronization and rollback-only tests were used.

The obsolete Android source and old mobile screenshots were moved into the private backup's `retired/` directory. Old frontend assets were replaced in place. Legacy backend models, expenses, reporting, breaks, night stays, device enrollment and signed-photo verification remain available for historical records and compatibility; the new website does not use native services or expose their retired screens. No records in these tables were removed. The `/app/smart-dsr` Desk page still redirects to `/smart-dsr`, preserving existing links. Old hash navigation no longer renders the retired screens.

## Implemented workflow

- Duty ON requires vehicle number, CNG/Diesel/Petrol, Home/Current Location and four independent manual declarations: Insurance, PUC, RC, FASTag. All start unchecked. The server rejects missing declarations and records Employee, confirming User and server timestamp on the duty. Existing employee locks and daily key prevent duplicate active duty creation. First opening cash still requires Administrator initialization.
- Foreground browser GPS feeds the existing validated sampling service. Fresh accurate location is required to start duty or a visit. Missing starting/arrival location blocks the operation; no coordinate fallback is invented. Duty OFF accepts the existing Administrator-authorized ending-GPS exception. Photo exceptions remain Administrator-only and audited.
- Duty ON shows only the active status and controls. Four cards use server cash and GPS totals. Uninitialized cash is explicitly labeled. The duration updates while active and freezes at Duty OFF. Closing cash uses the immutable ledger: opening + cash receipts + advances - tracked cash expenses - handovers ± authorized adjustments. Noncash collections do not increase tracked cash.
- Add Visit searches existing readable, assigned Customers by firm/name/mobile, with territory filtering. Creating a new Customer is absent. Arrival creates a durable draft; returning to the table and reloading preserves it. One open visit is allowed at a time. Server serialization assigns sequential numbers without an arbitrary visit limit.
- A secure-origin browser camera offers Open Camera, Capture, Preview and Retake. There is no gallery input. A short-lived authenticated challenge, bounded JPEG validation, GPS and private Frappe File association protect uploads. Evidence records identify the visit, Employee, capture/receipt timestamps and digest. The linked visit identifies the dealer. Files remain immutable under the existing File controller.
- Each visit stores the origin duty/previous departure, origin coordinates, travel start/arrival times, destination coordinates, elapsed travel time and verification state. Distance is the sum of eligible GPS sample segments within the travel interval. Missing/poor/gapped samples produce an explicit unverified leg and zero claimed leg distance. This is sampled travel distance, not a road-routing estimate or straight-line endpoint displacement.
- Make Order saves a server-authorized return reference for the existing draft and opens `/app/sales-order/new-sales-order`. The custom Sales Order hook prefills Customer, provides Back to DSR without saving, and returns after submission. The server checks token/user, visit ownership, active duty, submitted status, company and Customer before linking. Direct edits of the protected link are rejected. ERPNext core files are unchanged.
- Overdue Amount reads submitted company-scoped Sales Invoices and shows invoice, due date, outstanding, overdue days and total. Dealer Reviews records six feedback categories and permission-scoped prior reviews.
- Collected Money records allocated cash/noncash payments against the visit with stable request identifiers. Cash custody updates once. The existing **Administrator Accounts posting workflow** remains the authorization boundary: `post_collection` submits the Payment Entry once and allocates invoices; official invoice outstanding changes only after successful posting. The website clearly labels recorded/unposted collections. It does not silently elevate salesperson posting permissions. Outstanding is fetched anew when visit details open.
- Submit Visit validates the open duty, Customer draft and private photo/approved exception; records departure GPS/time; recalculates duty totals; returns to Party Visits; and leaves duty ON. Duplicate completion returns the existing visit. Completed visits reject further reviews, uploads and collections. Details show dealer/contact, arrival/departure, GPS, travel, photos, linked submitted orders, dues, collections, reviews and status.
- Duty OFF blocks open visits and breaks, captures available end GPS, recalculates cash and completes the existing DSR reconciliation/finalization. It does not finalize on individual visit submission.

## Schema and APIs

No new DocTypes were required. Additions:

| DocType | Additions |
| --- | --- |
| DSR Duty Session | Four document confirmations, confirming User and timestamp |
| DSR Dealer Activity | Visit number, previous origin visit, origin coordinates, travel start, verification state, structured review |
| DSR Collection | Link to Party Visit |
| Sales Order | Protected read-only `custom_dsr_visit` link via additive setup |

Existing DSR, Town, Lead, Expense, Receipt, Customer, cash ledger, GPS points, evidence and travel-leg records remain intact. Historical visits without the new metadata are labeled as historical/unverified; their old financial values are not rewritten.

API prefix: `/api/method/srv_erp.smart_dsr.api.`

New methods: `visit_details`, `browser_photo_challenge`, `browser_photo`, `save_visit_review`, `previous_reviews`, `visit_collection`, `order_return_reference`, `link_visit_order`, `end_workday`. Updated methods: `bootstrap`, `duty_on`, `dealer_arrival`, `complete_activity`, `summary`. Internal guards/helpers: `validate_documents`, `prepare_visit_travel`, `protect_order_visit`. All mutations require POST and existing Frappe sessions/CSRF. Employee ownership is derived server-side.

## Migration and verification

Full `bench --site local migrate --skip-search-index` synchronized schemas, then failed at the existing unrelated patch `srv_erp.patches.convert_box_group_uoms_to_bag`: **Item CB 312 has different Box and Bag conversion factors.** No inventory conversion factors or patch-log records were changed to bypass this failure. Full migration remains blocked pending an inventory-owner decision.

`bench --site local execute srv_erp.smart_dsr.setup.execute` succeeded and applied the idempotent DSR/Sales Order additions separately. `bench build --app srv_erp` succeeded. Final JavaScript syntax checks and Python compilation succeeded. Cache clearing passed for the updated hooks.

Backend verification: the existing/full rollback-only run passed 95 executed checks (including 33 inadvertently repeated fixture-class checks in that initial run). The duplicate import was removed. The final suite contains 65 distinct tests: 43 existing Smart DSR rules, 13 legacy financial tests and 9 website tests. Additional targeted website tests check every mandatory document, declaration identity/time, sequential draft/submitted visits, read-only completion, private browser photo/challenge replay, cash link idempotency, invalid and valid order associations, forged order links, verified GPS travel and Duty OFF reconciliation. See `verification.md` for the final results.

Chromium checks exercise the live guest route and production frontend code with isolated authenticated API fixtures, a simulated camera and deterministic GPS. They cover document gating, exactly four cards, duty lifecycle UI, Customer selection, browser camera capture/preview, visit submission, continued duty, read-only details and no page overflow at 1440px/390px. A separate contract check executes the actual Desk return hook for Customer prefill, unsaved Back to DSR and submitted return. Screenshots are in `/tmp/smart-dsr-screenshots/`; fixture images and names are not business data.

No real salesperson session, physical camera/GPS route, live invoice collection or interactive production Sales Order was exercised. ERPNext payment posting, outstanding refresh, cash, permission and compatibility logic are covered with rollback-only integration fixtures. Submitted-order association and frontend return-hook contract checks use isolated mocks, not an interactive ERPNext end-to-end submission.

## Run and verify

From `/workspace/development/frappe-bench-v15`:

```sh
bench --site local execute srv_erp.smart_dsr.setup.execute
bench build --app srv_erp
bench --site local clear-cache
bench --site local execute srv_erp.smart_dsr.testing.run
bench --site local serve --port 8001
```

Open `http://localhost:8001/smart-dsr` from the local browser, or your existing HTTPS forwarding URL with `/smart-dsr`. A remote plain-HTTP hostname will not provide camera/GPS permission. Existing DSR Settings, assigned readable Customers, active Employee/Sales Person mapping, role permissions and Administrator-initialized opening cash remain required. Real Accounts posting additionally requires the existing configured cash/bank accounts and accounting authorization.

With the current container's existing browser tools, run from the app directory:

```sh
LD_LIBRARY_PATH=/tmp/smart-dsr-libs/extracted/usr/lib/x86_64-linux-gnu NODE_PATH=/tmp/smart-dsr-browser/node_modules node ops/check_smart_dsr_ui.cjs
```

The full migration command above must be rerun after the unrelated Box/Bag conversion conflict has been properly resolved. This redesign does not resolve or suppress that inventory decision.

## Browser limits

GPS and camera need a secure origin and explicit permission. Background tabs, browser suspension/closure, OS restrictions, offline periods and location inaccuracy can interrupt sampling. No uninterrupted background service is promised. Gaps stay unverified. Browser camera challenges bind an upload to the authenticated open visit, but cannot cryptographically attest that an unmodified browser used a physical camera. Administrator exceptions remain explicit and audited; there is no automatic gallery or fabricated-coordinate fallback.
