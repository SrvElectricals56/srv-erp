# Merge verification — 21 November 2026

Merge preparation updates regression checks and fixtures without changing Smart DSR behavior or business data. The checks now match the current five summary cards (including Fuel Cost), assigned-vehicle controls, manual overdue entries, required receipt capture, and read-only administrator duty details. Existing target-branch changes are retained when preparing the feature base.

- All 211 isolated unit tests pass with live database access explicitly blocked. Run them from the bench directory with `env/bin/python apps/srv_erp/ops/check_smart_dsr_unit_tests.py`.
- All 41 isolated check scripts pass using API fixtures, simulated camera/GPS, and the current production frontend assets. This includes the lightweight Home collection dialog contract check. `ops/check_smart_dsr_ui.cjs` combines the current login, duty-location, odometer-camera, and photo-first workflows; it replaces the earlier website-only workflow, whose entry URL now redirects to Desk.
- The responsive check covers 84 cases across 14 phone, tablet, desktop and landscape viewports.
- The repository's configured pre-commit checks cover all staged files. The setup module is also checked with Pyright; its Frappe imports resolve in the bench environment.
- `feature-dsr` is based on the exact `origin/version-15` commit `65a23fbc3d26485f97ce8968d091ad5c371027c3`. Local `version-15` remains unchanged at `08a638d7326376ac70a21d44cb23163e844cbfc5`. The target branch's Customer Quick Entry asset and separate `eed82e0` patch-registration fix are retained; unrelated shortcut-branch work is excluded.

Deployment remains a separate check: the existing local site has not completed `srv_erp.patches.convert_box_group_uoms_to_bag`, and CB 312 has Box factor 120 and Bag factor 90. No business data was changed to bypass this conflict. The fetched target branch removes that patch from its patch list, so retain that upstream change when merging. Full migration after merging, a fresh-site installation, physical-device GPS/camera, and real accounting posting have not been revalidated by this isolated merge suite. The two authenticated Desk scripts require `SMART_DSR_SESSION_FILE` and are separate from the isolated checks.

## Historical verification — 14 November 2026

The following records describe that earlier implementation and environment, rather than the current merge suite.

| Check | Result |
| --- | --- |
| Site database/public/private/config backup | Completed; gzip/tar archive integrity verified |
| Code preservation | Safety branch `safety/smart-dsr-before-redesign-20261114` plus source archive |
| Full migration | BLOCKED by pre-existing Item CB 312 Box/Bag conversion-factor conflict |
| Additive DSR setup | Passed; includes Sales Order visit link |
| Initial and final asset builds | Passed |
| Initial backend regression run | Passed: 95 executions, including 33 repeated imported fixture-class tests |
| Final targeted website suite | Passed: 9 tests in 41.150 seconds |
| Submitted-order association targeted check | Passed; isolated Sales Order mock, real authenticated visit fixture |
| JavaScript syntax / Python compilation | Passed |
| Live guest `/smart-dsr` | HTTP 200; existing-login link verified |
| Authenticated browser workflow | Passed with isolated API/GPS fixtures and simulated browser camera |
| Desktop / mobile | 1440px and 390px, no page overflow, screenshots inspected |
| Standard Sales Order custom hook contract | Passed: prefill, Back without save, submitted return |
| Physical browser camera / continuous real GPS | Not tested on a physical device |
| Interactive ERPNext Sales Order submission and live financial posting | Not performed with business data |

The final source contains 65 distinct backend tests (43 existing Smart DSR, 13 legacy balance, 9 new website). The initial 95-execution run passed 62 distinct tests plus repeated imported fixtures. The final website run covers all 9 current website tests, including the 3 subsequently added checks. The duplicated fixture import was removed.

Evidence logs are local to this environment:

- `/tmp/smart-dsr-redesign-tests.log`
- `/tmp/smart-dsr-redesign-targeted-tests.log`
- `/tmp/smart-dsr-redesign-order-link-test.log`
- `/tmp/smart-dsr-redesign-browser.log`
- `/tmp/smart-dsr-redesign-build.log`

The full migration blocker was not bypassed or marked complete. No inventory conversions, opening cash initialization, real collections, business orders, document deletion or permission changes were made for testing. Test database writes use savepoints/rollback; generated test photo files are cleaned up.

See [README.md](README.md) for behavior, authorization boundaries, exact startup/verification commands and browser limitations, and [files.md](files.md) for the source inventory.

The temporary verification web server was stopped after checks. Start it again with the documented `bench --site local serve --port 8001` command.
