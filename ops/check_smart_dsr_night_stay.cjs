const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            ok({
              timestamp: Date.now(),
              coords: { latitude: 28, longitude: 77, accuracy: 5 },
            });
          },
          watchPosition(ok) {
            const id = setTimeout(
              () =>
                ok({
                  timestamp: Date.now(),
                  coords: { latitude: 28, longitude: 77, accuracy: 5 },
                }),
              50
            );
            setTimeout(
              () =>
                ok({
                  timestamp: Date.now(),
                  coords: { latitude: 28, longitude: 77, accuracy: 1500 },
                }),
              0
            );
            return id;
          },
          clearWatch(id) {
            clearTimeout(id);
          },
        },
      })
    );
    let eligible = false,
      canOff = false,
      stay = null,
      balance = 5000,
      outside = true,
      onCalls = 0,
      offCalls = 0;
    const expenses = [];
    const duty = {
      name: "duty",
      status: "Active",
      work_date: "2026-11-16",
      started_at: "2026-11-16 09:30:00",
      opening_balance: 5000,
    };
    const info = function () {
      return {
        can_on: eligible && !stay,
        can_off: canOff && stay && !stay.checked_out_at,
        active: stay && !stay.checked_out_at ? stay : null,
        latest: stay,
        off_available_at: "2026-11-17T01:30:00+05:30",
        message: stay?.checked_out_at
          ? "Night stay is already recorded for this night."
          : "Night Stay ON requires 9:30 PM IST and at least 12 hours of duty.",
      };
    };
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
      const method = r.request().url().split(".").pop(),
        data = r.request().postDataJSON();
      let message = {};
      if (method === "bootstrap")
        message = {
          account: "user",
          employee_name: "User",
          work_date: "2026-11-16",
          currency: "INR",
          current: {
            duty,
            available_cash: balance,
            activities: [],
            expenses,
            events: [],
            night_stay: info(),
          },
        };
      if (method === "night_stay_on") {
        onCalls++;
        assert.equal(data.gps.latitude, 28);
        assert.equal(data.gps.accuracy, 5);
        stay = {
          name: "stay",
          latitude: 28,
          longitude: 77,
          checked_in_at: "2026-11-16T21:30:00+05:30",
        };
        message = "stay";
      }
      if (method === "duty_off_readiness")
        message =
          stay && !stay.checked_out_at
            ? {
                ready: false,
                message: "Switch Night Stay OFF before Duty OFF.",
                tasks: [{ type: "night_stay" }],
              }
            : { ready: true, tasks: [] };
      if (method === "night_stay_off") {
        offCalls++;
        assert.equal(data.stay, "stay");
        assert.equal(data.gps.longitude, 77);
        if (outside)
          return r.fulfill({
            status: 417,
            json: {
              message:
                "Return within 500 metres of the Night Stay ON location.",
            },
          });
        if (!stay.checked_out_at) {
          balance -= 1200;
          Object.assign(stay, {
            checked_out_at: "2026-11-17T01:30:00+05:30",
            checkout_latitude: 28,
            checkout_longitude: 77,
            checkout_distance_m: 0,
            expense_amount: 1200,
          });
          expenses.push({
            category: "Night Stay",
            amount: 1200,
            paid_from_cash: 1,
            posting_status: "Recorded",
          });
        }
        message = "stay";
      }
      return r.fulfill({ json: { message } });
    });
    const source = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
        "utf8"
      ),
      css = fs.readFileSync(
        path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
        "utf8"
      );
    await page.route("**/night-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><style>${css}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user';</script><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/night-test");
    assert.equal(
      await page
        .getByRole("button", { name: "Night Stay ON", exact: true })
        .isDisabled(),
      true
    );
    eligible = true;
    await page.reload();
    await page
      .getByRole("button", { name: "Night Stay ON", exact: true })
      .click();
    await page.locator("[data-confirm-night]").click();
    await page
      .getByRole("button", { name: "Night Stay OFF", exact: true })
      .waitFor();
    assert.equal(onCalls, 1);
    assert.equal(
      await page
        .getByRole("button", { name: "Night Stay OFF", exact: true })
        .isDisabled(),
      true
    );
    await page.getByRole("button", { name: "Duty OFF", exact: true }).click();
    await page
      .getByText("Switch Night Stay OFF before Duty OFF.", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#dsr-dialog").evaluate((d) => d.open),
      false
    );
    canOff = true;
    await page.reload();
    await page
      .getByRole("button", { name: "Night Stay OFF", exact: true })
      .click();
    await page.locator("[data-confirm-night]").click();
    await page
      .getByText("Return within 500 metres of the Night Stay ON location.", {
        exact: true,
      })
      .first()
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#smart-dsr").hasAttribute("aria-busy")
    );
    assert.equal(balance, 5000);
    assert.equal(expenses.length, 0);
    outside = false;
    await page.locator("[data-confirm-night]").click();
    await page
      .locator("#night-stay")
      .getByText(/OFF location:/)
      .waitFor();
    assert.equal(balance, 3800);
    assert.equal(expenses.length, 1);
    assert.match(
      await page.locator(".summary-cards .metric").nth(1).innerText(),
      /3,800/
    );
    assert.match(await page.locator("#dsr-expenses").innerText(), /Night Stay/);
    assert.match(
      await page.locator("#night-stay").innerText(),
      /28.00000, 77.00000/
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Night Stay ON", exact: true })
        .isDisabled(),
      true
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      ),
      false
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: Night Stay ON eligibility; four-hour OFF gate; Duty OFF blocked while stay active; outside-location error; valid OFF adds one 1200 expense and reduces balance; ON/OFF locations displayed; mobile layout. API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
