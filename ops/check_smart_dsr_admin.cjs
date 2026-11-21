const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const today = "2026-11-14";
  const account = "salesperson@example.invalid";
  let mutations = [];
  const duty = {
    name: "test-duty",
    doctype: "DSR Duty Session",
    account,
    employee: null,
    work_date: today,
    status: "Closed",
    vehicle_number: "PB31AB1234",
    fuel_type: "CNG",
    started_at: today + "T09:00:00+05:30",
    ended_at: today + "T17:00:00+05:30",
    start_location: "Current Location",
    opening_balance: 1000,
    closing_balance: 1100,
    verified_km: 5,
    duty_minutes: 480,
    total_visits: 1,
    collections: 100,
    confirmed_insurance: 1,
    confirmed_puc: 1,
    confirmed_rc: 1,
    confirmed_fastag: 1,
    gps_status: "Stopped",
  };
  const person = {
    name: account,
    account,
    employee_name: "Test Salesperson",
    full_name: "Test Salesperson",
    employee: null,
    enabled: 1,
    smart_dsr_disabled: 0,
    mapping_status: "No Employee (optional)",
    territories: ["Test Territory"],
    duty_status: "Closed",
    opening_balance: 1000,
    closing_balance: 1100,
    verified_km: 5,
    duty_minutes: 480,
    total_visits: 1,
    collections: 100,
    duty: duty.name,
  };
  const visit = {
    name: "test-visit",
    doctype: "DSR Dealer Activity",
    account,
    duty: duty.name,
    customer: "Test Dealer",
    visit_number: 1,
    status: "Open",
    arrived_at: today + "T10:00:00+05:30",
    travel_distance_km: 1,
    travel_duration_seconds: 900,
    travel_verification: "Verified GPS samples",
    remarks: "",
    dealer_review: "{}",
    collections: 100,
    sales_orders: [],
  };
  const collection = {
    name: "test-collection",
    doctype: "DSR Collection",
    account,
    duty: duty.name,
    customer: "Test Dealer",
    activity: visit.name,
    amount: 100,
    payment_method: "Cash",
    collected_at: today + "T10:05:00+05:30",
    allocations: "[]",
    verification_status: "Recorded",
    transaction_reference: "",
  };
  const expense = {
    name: "test-expense",
    doctype: "DSR Expense Record",
    account,
    duty: duty.name,
    category: "Parking",
    amount: 20,
    paid_from_cash: 1,
    posting_status: "Recorded",
    recorded_at: today + "T11:00:00+05:30",
  };
  const recordRows = {
    vehicles: [
      {
        name: "PB31AB1234",
        registration_number: "PB31AB1234",
        fuel_type: "CNG",
        status: "Active",
        fastag_available: 1,
        added_by: "creator@example.invalid",
        added_by_name: "Vehicle Creator",
        added_by_salesperson: "EMP-TEST",
      },
    ],
    people: [person],
    balances: [person],
    employees: [
      {
        name: "EMP-TEST",
        employee_name: "Test Salesperson",
        user_id: account,
        status: "Active",
        company: "SRV Electricals",
      },
    ],
    duties: [duty],
    visits: [visit],
    collections: [collection],
    expenses: [expense],
    dsrs: [
      {
        name: "test-dsr",
        owner: account,
        date: today,
        docstatus: 0,
        smart_duty: duty.name,
        opening_balance: 1000,
        closing_balance: 1100,
      },
    ],
    audit: [
      {
        name: "test-audit",
        actor: "Administrator",
        affected_user: account,
        record_type: "DSR Duty Session",
        record_id: duty.name,
        action: "Note",
        reason: "Reviewed",
        recorded_at: today + "T18:00:00+05:30",
        outcome: "Applied",
      },
    ],
    gps: [
      {
        name: "test-gps-event",
        account,
        event_type: "Interrupted",
        recorded_at: today + "T12:00:00+05:30",
        details: "Browser suspended",
      },
    ],
    outstanding: [
      {
        name: "INV-TEST",
        customer: "Test Dealer",
        due_date: today,
        outstanding_amount: 500,
        currency: "INR",
      },
    ],
  };
  const metrics = {
    total_salespersons: 1,
    on_duty: 0,
    off_duty: 1,
    party_visits: 1,
    cash_collections: 100,
    noncash_collections: 0,
    expenses: 20,
    outstanding_reviewed: 500,
    pending_review: 1,
    gps_exceptions: 1,
  };
  await page.route("**/api/method/srv_erp.smart_dsr.admin.*", async (route) => {
    const method = route.request().url().split(".").pop();
    const data = route.request().postDataJSON();
    let message;
    if (method === "bootstrap")
      message = {
        user: "Administrator",
        today,
        currency: "INR",
        can_manage_users: true,
        can_finance: true,
        users: [{ name: account, full_name: "Test Salesperson" }],
      };
    else if (method === "overview") message = metrics;
    else if (method === "visit_dealer_options") message = [];
    else if (method === "list_records")
      message = {
        rows: recordRows[data.dataset] || [],
        total: (recordRows[data.dataset] || []).length,
        page: 1,
        page_size: 20,
      };
    else if (method === "report") {
      const dataset =
        {
          "Dealer Visits": "visits",
          Collections: "collections",
          "Outstanding Dues": "outstanding",
          Expenses: "expenses",
          "Cash Balances": "balances",
          "GPS Exceptions": "gps",
        }[data.report] || "duties";
      message = {
        rows: recordRows[dataset],
        total: 1,
        page: 1,
        page_size: 20,
        dataset,
        totals: dataset === "duties" ? metrics : null,
      };
    } else if (method === "details") {
      if (["people", "balances"].includes(data.dataset))
        message = {
          profile: person,
          current_duty: duty,
          roles: ["Sales User"],
          initial_opening: 1000,
          current_cash: 1100,
          previous_finalized: null,
          duties: { rows: [duty], total: 1 },
          dsrs: { rows: recordRows.dsrs, total: 1 },
          ledger: { rows: [], total: 0 },
        };
      else
        message = {
          record: recordRows[data.dataset]?.[0] || duty,
          audit: [],
          photos: [],
          collections: [],
          orders: [],
        };
    } else {
      mutations.push({ method, ...data });
      message = {
        audit: "AUDIT-TEST",
        record: data.name || data.user || data.duty,
        transaction: "LEDGER-TEST",
        outcome: "Applied",
      };
    }
    await route.fulfill({ json: { message } });
  });
  const css = fs.readFileSync(
    path.join(__dirname, "../srv_erp/public/smart_dsr/admin.css"),
    "utf8"
  );
  const js = fs.readFileSync(
    path.join(__dirname, "../srv_erp/public/smart_dsr/admin.js"),
    "utf8"
  );
  await page.route("**/admin-ui-test", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="dsr-admin"></div><script>window.dsr_admin_csrf='fixture';</script><script>${js}</script>`,
    })
  );
  await page.goto("http://127.0.0.1:8001/admin-ui-test");
  await page
    .getByRole("heading", { name: "Overview", exact: true, level: 1 })
    .waitFor();
  assert.equal(await page.locator(".admin-metrics section").count(), 6);
  assert.equal(await page.locator(".admin-sidebar nav a").count(), 11);
  fs.mkdirSync("/tmp/smart-dsr-admin-screenshots", { recursive: true });
  await page.screenshot({
    path: "/tmp/smart-dsr-admin-screenshots/overview-desktop.png",
    fullPage: true,
  });
  for (const [route, title] of [
    ["people", "Salespersons"],
    ["vehicles", "Vehicles"],
    ["balances", "Opening Balances"],
    ["duties", "Duty Records"],
    ["visits", "Party Visits"],
    ["collections", "Collections"],
    ["expenses", "Expenses"],
    ["dsrs", "DSR Records"],
    ["reports", "Reports"],
    ["audit", "Audit Logs"],
  ]) {
    await page.locator(`nav a[href="#${route}"]`).click();
    await page
      .getByRole("heading", { name: title, exact: true, level: 1 })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
  }
  await page.locator('nav a[href="#vehicles"]').click();
  await page
    .getByRole("heading", { name: "Vehicles", exact: true, level: 1 })
    .waitFor();
  assert.equal(
    await page
      .getByRole("columnheader", { name: "Added By", exact: true })
      .count(),
    1
  );
  for (const name of ["Insurance Available", "Puc Available", "Rc Available"])
    assert.equal(
      await page.getByRole("columnheader", { name, exact: true }).count(),
      0
    );
  const vehicleHeaders = await page.locator("table th").allTextContents();
  const fastagIndex = vehicleHeaders.indexOf("FASTag Available");
  assert.ok(fastagIndex >= 0);
  assert.equal(
    await page
      .locator("table tbody tr")
      .first()
      .locator("td")
      .nth(fastagIndex)
      .innerText(),
    "Yes"
  );

  assert.equal(
    await page
      .getByRole("columnheader", { name: "Added By Salesperson", exact: true })
      .count(),
    0
  );
  assert.equal(
    await page
      .getByRole("cell", { name: "Vehicle Creator", exact: true })
      .count(),
    1
  );
  await page.getByRole("button", { name: "View Details", exact: true }).click();
  await page.locator("#admin-dialog[open]").waitFor();
  assert.match(
    await page.locator("#admin-dialog").innerText(),
    /Vehicle Creator/
  );
  assert.doesNotMatch(
    await page.locator("#admin-dialog").innerText(),
    /Added By Salesperson/
  );
  await page.locator("#admin-dialog [data-close]").click();
  async function checkLabels(container) {
    for (const label of await container
      .locator("label.dsr-checkbox-option")
      .all()) {
      const span = label.locator("span");
      assert.equal(await span.isVisible(), true);
      const style = await span.evaluate((el) => ({
        color: getComputedStyle(el).color,
        size: parseFloat(getComputedStyle(el).fontSize),
        text: el.textContent.trim(),
        width: el.getBoundingClientRect().width,
      }));
      assert.ok(["rgb(17, 24, 39)", "rgb(0, 0, 0)"].includes(style.color));
      assert.ok(style.size >= 12 && style.width > 10 && style.text.length > 0);
      const input = label.locator("input[type=checkbox]");
      const before = await input.isChecked();
      await span.click();
      assert.equal(await input.isChecked(), !before);
      await span.click();
      assert.equal(await input.isChecked(), before);
    }
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of [
      "overview",
      "people",
      "vehicles",
      "balances",
      "duties",
      "visits",
      "collections",
      "expenses",
      "dsrs",
      "reports",
      "audit",
    ]) {
      const link = page.locator(`nav a[href="#${route}"]`);
      const title = await link.innerText();
      await link.click();
      await page
        .getByRole("heading", { name: title, exact: true, level: 1 })
        .waitFor();
      await page.locator("#admin-filters").waitFor();
      await checkLabels(page.locator("#admin-filters"));
    }
    await page.locator('nav a[href="#people"]').click();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit Smart DSR Access", exact: true })
      .click();
    await checkLabels(page.locator("#admin-dialog"));
    await page.locator("#admin-dialog [data-close]").click();
    await page.locator('nav a[href="#vehicles"]').click();
    await page
      .getByRole("button", { name: "Add Vehicle", exact: true })
      .click();
    assert.equal(
      await page.locator("#admin-dialog [name=reason_text]").count(),
      0
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Save Vehicle", exact: true })
        .count(),
      1
    );
    await checkLabels(page.locator("#admin-dialog"));
    await page.locator("#admin-dialog [data-close]").click();
    await page.locator('nav a[href="#expenses"]').click();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    assert.equal(
      await page
        .getByRole("button", { name: "Reverse and Replace", exact: true })
        .count(),
      0
    );
    await page.locator("#admin-dialog [data-close]").click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('nav a[href="#balances"]').click();
  await page
    .getByRole("button", { name: "Add Opening Amount", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Add Opening Amount", exact: true })
      .count(),
    1
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Record Returned Cash", exact: true })
      .count(),
    1
  );
  await page.locator('nav a[href="#collections"]').click();
  await page
    .getByRole("heading", { name: "Collections", exact: true, level: 1 })
    .waitFor();
  await page.getByRole("button", { name: "View Details", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Reverse and Replace", exact: true })
      .count(),
    0
  );
  await page.locator("#admin-dialog [data-close]").click();
  assert.equal(mutations.length, 0);
  await page.locator('nav a[href="#overview"]').click();
  await page
    .getByRole("heading", { name: "Overview", exact: true, level: 1 })
    .waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  );
  await page.screenshot({
    path: "/tmp/smart-dsr-admin-screenshots/overview-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "PASS: eleven admin screens, six overview metrics, user access and vehicle dialogs, read-only financial details, opening movement controls, checkbox labels and desktop/mobile layout. API responses are isolated fixtures."
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
