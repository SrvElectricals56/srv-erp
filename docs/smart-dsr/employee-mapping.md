> Superseded: Smart DSR now uses enabled User accounts directly. Employee and salesperson mappings are no longer login requirements. See [User login](user-login.md). The following is the historical diagnosis.

# Smart DSR Employee mapping diagnosis

## Confirmed root cause

Chrome is signed in as **Administrator**, confirmed by the user. The latest server-side local session also belongs to Administrator. Read-only inspection of site `local` found:

| Check | Administrator |
| --- | --- |
| Required `Sales User` / `Sales Rapl` role | Present |
| Employee with `user_id = Administrator` | None |
| Active Employee count | 0; Smart DSR requires exactly 1 |
| Existing enabled Sales Person | Anmol |
| Anmol Mapped User (`sales_user`) | Administrator |
| Anmol Employee | Empty |

The original exception was raised by `employee_for()` in `srv_erp/smart_dsr/security.py`, called from `identity()` and then `bootstrap()`. The query is scoped to the authenticated `frappe.session.user`, requiring Employee `status = Active`. It correctly rejects Administrator's missing mapping. This is account configuration, not a Chrome-specific authentication bug. Browser session records alone do not identify Chrome versus Edge; the account identification above combines the server audit with the user's explicit confirmation. Edge's current account was not identified or changed.

## Desk versus Smart DSR

Desk screens, including Package Barcode Tools, have their own module/role access requirements. Successful Desk access does not establish an Employee or salesperson mapping.

Smart DSR requires all of the following:

1. An authenticated Frappe User.
2. `Sales User` or `Sales Rapl` role.
3. Exactly one **Active** Employee whose User ID is that authenticated User.
4. An enabled Sales Person whose **Employee** is the same Employee and whose **Mapped User** (`sales_user`) is the same User.
5. Existing Customer permissions and DSR Settings for subsequent business operations. Starting duty also requires Administrator-initialized cash and existing duty validations.

Administrator has no blanket ban on the salesperson APIs and no Employee-mapping bypass. Its separate management/read privileges and Administrator-only financial controls remain intact. Stock-only users and unmapped administrators cannot enter the salesperson workflow merely because Desk opens.

## Configuration steps

Use a dedicated salesperson User when recording an actual salesperson's work. Do not create a fictitious Employee solely to silence the error.

As Administrator in Desk:

1. Open the intended **User** and assign the appropriate existing `Sales User` or `Sales Rapl` role.
2. Open or create that person's legitimate **Employee**. Set **Status = Active** and **User ID = the exact login account**. Ensure no second Active Employee maps to that same User. If an existing Employee is inactive, review its real employment status before changing it.
3. Open the intended **Sales Person**. Set **Employee** to that Employee, **Mapped User** to the same User, and **Enabled** on. Existing validation permits only one Sales Person per mapped User; correct existing records rather than creating duplicate mappings.
4. Preserve existing Customer assignments and permissions. Configure DSR Settings/opening balance through the existing authorized process if not already set up; Employee mapping does not grant accounting or Customer access automatically.
5. Sign out in Chrome and sign in with that configured User at the same host, `http://127.0.0.1:8001`. Open `/smart-dsr`. Chrome, Edge, private profiles, `localhost` and `127.0.0.1` can hold different cookies; compare the displayed signed-in account rather than assuming another browser's login applies.

If Administrator itself must represent a real salesperson, its legitimate Employee must have User ID `Administrator`, and the existing Anmol Sales Person must link that same Employee. Its required roles already exist. No mapping or role changes were made automatically in this task.

## Code changes

- Split the generic Employee exception into missing, inactive and duplicate-Active mapping messages with corrective instructions. The exact-one-Active rule remains unchanged, including the two-row duplicate guard.
- Clarified missing salesperson-role and disabled/mismatched Sales Person errors.
- Fixed a separate bootstrap lookup: it now filters enabled Sales Person by both Employee **and authenticated `sales_user`**, matching `identity()`. Previously bootstrap could select a different user's Sales Person for an Employee and falsely reject an otherwise valid account. This was not the cause of Administrator's missing Employee.
- The startup error screen now displays the server-rendered authenticated account, explains the separate Desk requirement, and offers an existing-CSRF-protected **Sign out and switch account** action. It does not authenticate as another User or grant permissions.
- Added `srv_erp/tests/test_smart_dsr_mapping.py` and registered it in the rollback-only test runner. Tests cover valid/unmapped/inactive/duplicate mapping, Active-only counting, Guest, missing roles, disabled/mismatched Sales Person, bootstrap user scoping, and Administrator's lack of a mapping bypass or blanket ban. Duplicate-row corruption is simulated at the query boundary because normal Employee validation prevents it.
- Added isolated browser UI fixtures in `ops/check_smart_dsr_mapping_ui.cjs` for Chrome/Edge user agents, account-specific failure, switch-account control, and successful mapped-account rendering. This is Chromium with different user-agent fixtures, not physical testing of both installed browsers.

No database migration is needed. No real Employee, role, permission, cash ledger, financial record, or salesperson mapping was modified. Test fixtures are rolled back.

## Verification commands

From `/workspace/development/frappe-bench-v15`:

```sh
bench --site local execute srv_erp.smart_dsr.testing.run --kwargs '{"modules":["srv_erp.tests.test_smart_dsr_mapping"]}'
bench build --app srv_erp
```

From `apps/srv_erp`, using the browser tools already present in this environment:

```sh
LD_LIBRARY_PATH=/tmp/smart-dsr-libs/extracted/usr/lib/x86_64-linux-gnu NODE_PATH=/tmp/smart-dsr-browser/node_modules node ops/check_smart_dsr_mapping_ui.cjs
```

The changed files are `srv_erp/smart_dsr/security.py`, `srv_erp/smart_dsr/api.py`, `srv_erp/smart_dsr/testing.py`, `srv_erp/public/smart_dsr/app.js`, and the new test, browser check and this guide. Existing financial and document authorization code was not relaxed.

## Verification results

- Final mapping suite: **11/11 passed**, including mapped, unmapped, inactive and duplicate-Active accounts (`/tmp/smart-dsr-mapping-targeted.log`).
- Existing Smart DSR and legacy balance cases: **56 passed** in the broader regression run. That initial run also contained one failing assertion in the new query-recording test; the recorder was corrected and the final mapping suite passed. Financial and permission tests did not fail (`/tmp/smart-dsr-mapping-tests.log`).
- Asset build: passed (`/tmp/smart-dsr-mapping-build.log`).
- JavaScript syntax, Python compilation, whitespace checks: passed.
- Isolated Chrome/Edge user-agent UI checks: passed. The actual logged-in Chrome/Edge cookie stores were not accessed or changed. Refresh the running development site to see the improved account-specific error.
