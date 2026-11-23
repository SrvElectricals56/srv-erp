# Smart DSR uses existing User accounts

Every **enabled, authenticated User** can open `/smart-dsr` with the existing Frappe email/password login. Administrator is included. Employee ID, Employee records, Employee status, Sales Person mapping and `Sales User`/`Sales Rapl` roles are no longer prerequisites for entering Smart DSR. Guest and disabled/deleted accounts remain blocked. No accounts, passwords, Employees or Sales Persons are automatically created.

Sign in using the same account created under `/app/user` at `/login?redirect-to=/smart-dsr`. Existing password validation, sessions, CSRF, rate limits and any configured two-factor authentication remain unchanged. Each browser retains its own login session.

## Ownership and permissions

- Twelve operational DSR DocTypes now have a read-only **User Account** (`account`, Link to User). New records are keyed to the authenticated User and service writes remain enforced. The existing Employee fields remain stored, hidden and optional for historical evidence.
- Duty, visits, photos, GPS, expenses, cash, collections and reporting use the User account. User-row locks serialize duty and financial mutations. The frontend uses the User's full name.
- Read permissions allow authenticated Users to read their own DSR records only. Administrator retains existing management read access. Direct document writes/deletes remain prohibited; opening balances and cash adjustments are still Administrator-only. No broad Customer, Sales Order, invoice or Payment Entry permissions were granted.
- If an enabled Sales Person is already mapped to a User, its existing Customer assignment filter still applies. Users without that mapping can use Customers readable under their existing Frappe permissions. Logging in does not grant Customer access or accounting posting rights.
- Existing company settings and Administrator-initialized opening cash remain necessary to start duty. Missing company configuration displays a setup notice after login rather than an Employee mapping error. No opening balance is invented.

## Migration and preservation

`setup.execute` now reloads the twelve affected DocTypes and backfills User Account from an existing Employee's User ID or the parent duty, without removing Employee fields, changing amounts or reposting transactions. Historical records with no resolvable User remain unassigned and Administrator-readable; ownership is not guessed from the current browser login. Existing request identifiers and original Employee evidence remain stored, with fallback retry checks for migrated records.

The existing DSR remains the parent report. New user-only reports without a Sales Person use a `SMART-DSR-<duty>` name; no fictitious Sales Person is created. Ordinary DSR history keeps its previous names and fields.

Backup: `sites/local/private/backups/20261114_121614-local-*`, database and public/private files verified. Source snapshot: `/workspace/development/dsr-backup/user-login-before-change.tgz`.

Applied additive setup:

```sh
cd /workspace/development/frappe-bench-v15
bench --site local execute srv_erp.smart_dsr.setup.execute
bench build --app srv_erp
```

No complete migration was attempted again because the previously documented unrelated Item CB 312 Box/Bag patch remains unresolved. The targeted setup passed independently.

Administrator initializes first cash by **User**, not Employee:

```python
from srv_erp.smart_dsr.api import initialize_balance
initialize_balance('salesperson@example.com', 1000, 'unique-request-identifier', 'Verified initial cash custody')
```

This example was not run against a real account. Replace its User and amount only through your actual authorized custody process.

## Tests

Run the complete rollback-only suite:

```sh
bench --site local execute srv_erp.smart_dsr.testing.run
```

The new `test_smart_dsr_user_login.py` covers Users with no Employee/Sales Person, no sales role, Guest/disabled rejection, own-duty lifecycle, other-user denial, cash initialization protection, preserved Customer permissions, Administrator access, missing company configuration and historical ledger preservation. The superseded Employee-required mapping tests and browser harness were retired into `/workspace/development/dsr-backup/`.

`ops/check_smart_dsr_user_login_ui.cjs` verifies Administrator and ordinary-user rendering with isolated API fixtures. It does not change or inspect real browser cookie stores or passwords. Existing standard Frappe login code is reused.

## Verified results

- Database/attachment backup verified; additive setup passed; asset build passed.
- Final focused run: **13 tests passed** (12 User-login/historical-ownership tests and the account-isolation regression), including starting and finalizing duty with no Employee or Sales Person and no sales roles.
- Earlier broad run: 76 executions, 73 passed. Three failures exposed an outdated Employee-authorization test assertion and a remaining Sales Order-read assumption in User-only duty summaries. Both were corrected and the focused run passed all affected paths. The historical migration test was added after that initial run and passed in the final focused run. A second complete suite was not rerun.
- Isolated Administrator/ordinary-User browser rendering checks passed.
- Actual local Administrator `bootstrap()` succeeded with `account=Administrator`; no Employee mapping was created.
- Python compilation, JavaScript syntax and whitespace checks passed.
- Evidence: `/tmp/smart-dsr-user-login-tests.log`, `/tmp/smart-dsr-user-login-targeted.log`, `/tmp/smart-dsr-user-login-browser.log`, `/tmp/smart-dsr-user-login-build.log`.

Refresh `/smart-dsr` after signing in. The script URL includes a new version marker to refresh the browser's cached frontend.

## Duty starting location

The Duty ON form now automatically requests browser GPS and displays area and city names with the update time instead of the Home/Current Location selector. Refresh Location requests another fix. Location failure is shown inline and disables Duty ON until location is available and all four document declarations are checked. Submission obtains a fresh fix and saves it as Current Location through the existing server GPS validation. Current browser coordinates are resolved directly on the device through BigDataCloud; no IP-location fallback or guessed address is used. HTTPS/localhost and browser location permission are required.

`ops/check_smart_dsr_duty_location.cjs` passed area/city display, hidden coordinates, failed-lookup and IP-fallback handling, refresh, denied-permission blocking, checklist gating and fresh GPS submission using simulated browser coordinates and geocoding responses. JavaScript syntax and whitespace checks passed. No backend/schema changes were required for this UI update.

Area/city resolution uses the client-only endpoint documented at https://www.bigdatacloud.com/docs/free-api/free-reverse-geocode-to-city-api. The browser sends only its current permission-granted coordinates directly to BigDataCloud; Frappe passwords/session cookies are not sent (`credentials: omit`). This follows https://www.bigdatacloud.com/docs/article/fair-use-policy-for-free-client-side-reverse-geocoding-api. Lookups run only on the Duty form's current fix, explicit refresh, or fresh Duty ON fix, not on background tracking/history. The UI names the provider. Network/coverage failures show a retry message without coordinates, and do not substitute IP-based names. Raw GPS is still validated and saved internally by the existing duty backend. No live lookup was made using synthetic test coordinates.

The successful Duty location display now contains only the available area and city names. Timestamp/provider text and the normal Refresh button are removed; Retry Location appears only when lookup fails.

## Approximate browser GPS

Duty ON/OFF and browser visit/photo events now accept valid permission-granted browser coordinates even when accuracy exceeds the configured verified-distance threshold. Original accuracy is stored unchanged. This removes the desktop-browser “GPS accuracy is insufficient” blocker without claiming precise GPS or upgrading approximate travel to verified distance. Missing/invalid coordinates remain errors. GPS sample verification, distance/fuel calculations, geofence rules, legacy signed-camera precision and night-stay center precision remain protected. The active tracking status reports unverified GPS rather than falsely reporting verified travel.

Accuracy-fix verification: 7 targeted backend tests passed, including duty start/finalization with 5,000 m browser accuracy, stored original uncertainty, zero verified distance, unchanged cash, invalid-coordinate rejection, strict legacy evidence checks, and interruption/resume/deduplication. The browser location fixture also passed with 5,000 m accuracy while displaying only area/city. Evidence: `/tmp/smart-dsr-approximate-gps-tests.log`. No accuracy values or distance-verification thresholds were reduced or falsified.

## Indian vehicle numbers

Duty ON validates vehicle registration in both the browser and backend. Supported permanent registrations include State/UT marks (including retained historical state codes), one/two-digit registering-authority codes, optional series letters (up to three for formats such as Delhi), and a nonzero number up to four digits. BH-series marks support the year/BH/four-digit nonzero number/letter-series format. Spaces/hyphens and lowercase are accepted and normalized to uppercase without separators; short ordinary serial numbers are padded to four digits. Example inputs: `PB31AB1234`, `PB-31-AB-1234`, `DL1CAA1234`, `22BH1234AA`.

Invalid state prefixes, zero-only registration numbers, missing components, excessive series/serial lengths and punctuation are rejected. The input offers an example and browser validation; the server repeats validation before inserting a duty. Existing historical vehicle values are not rewritten. This is permanent-registration format validation, not a VAHAN/RC verification or ownership lookup; special military, diplomatic and temporary marks are outside this input's supported formats.

Official references: [State registration marks](https://transport.telangana.gov.in/html/registration-statecodes.html), [BH-series format](https://www.pib.gov.in/PressReleasePage.aspx?PRID=1749841&lang=2&reg=48). Telangana TG and existing TS marks are retained rather than rewriting existing registrations.

Vehicle validation verification: four backend tests passed (supported/invalid formats, API rejection before insertion, and a complete user-only duty lifecycle); browser checks also passed invalid input rejection, uppercase/separator normalization and normalized submission. Evidence: `/tmp/smart-dsr-vehicle-number-tests.log`.
