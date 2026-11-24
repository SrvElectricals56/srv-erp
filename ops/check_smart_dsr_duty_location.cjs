const { chromium } = require("playwright");
const fs = require("fs"),
  path = require("path"),
  assert = require("assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const page = await browser.newPage({ permissions: ["camera"] });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.denyLocation = false;
    window.locationCalls = 0;
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition(success, error) {
          window.locationCalls++;
          setTimeout(
            () =>
              window.denyLocation
                ? error({ code: 1 })
                : success({
                    coords: {
                      latitude: 28.6139,
                      longitude: 77.209,
                      accuracy: 5000,
                    },
                  }),
            10
          );
        },
        watchPosition() {
          return 1;
        },
        clearWatch() {},
      },
    });
  });
  let failLookup = false,
    ipLookup = false;
  await page.route(
    "https://api.bigdatacloud.net/data/reverse-geocode-client?*",
    (r) => {
      const url = new URL(r.request().url());
      assert.equal(url.searchParams.get("latitude"), "28.6139");
      assert.equal(url.searchParams.get("longitude"), "77.209");
      return r.fulfill(
        failLookup
          ? { status: 503, json: {} }
          : {
              json: {
                locality: "Connaught Place",
                city: "New Delhi",
                lookupSource: ipLookup ? "IP geolocation" : "reverseGeocoding",
              },
            }
      );
    }
  );
  let submitted, added;
  const vehicles = [
    { registration_number: "PB31AB1234" },
    { registration_number: "DL1CAA1234" },
  ];
  await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) => {
    if (r.request().url().endsWith(".odometer_camera_challenge"))
      return r.fulfill({ json: { message: "starting-odometer-token" } });
    if (r.request().url().endsWith(".duty_on"))
      submitted = r.request().postDataJSON();
    if (r.request().url().endsWith(".add_vehicle")) {
      const payload = r.request().postDataJSON();
      added =
        typeof payload.values === "string"
          ? JSON.parse(payload.values)
          : payload.values;
      vehicles.splice(0, vehicles.length, {
        registration_number: added.registration_number,
      });
      return r.fulfill({
        json: { message: { registration_number: added.registration_number } },
      });
    }
    return r.fulfill({
      json: {
        message: {
          vehicles,
          account: "user@example.invalid",
          employee_name: "Test User",
          sales_person: null,
          configured: true,
          official_opening_balance: 1000,
          currency: "INR",
          current: null,
          territories: [],
        },
      },
    });
  });
  const source = fs.readFileSync(
    path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
    "utf8"
  );
  const stylesheet = fs.readFileSync(
    path.join(__dirname, "../srv_erp/public/smart_dsr/app.css"),
    "utf8"
  );
  await page.route("**/location-test", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset="utf-8"><style>${stylesheet}</style><div id="smart-dsr"></div><script>window.smart_dsr_user='user@example.invalid';window.smart_dsr_csrf='test';</script><script>${source}</script>`,
    })
  );
  await page.goto("http://127.0.0.1:8001/location-test");
  await page.getByText("Connaught Place, New Delhi").waitFor();
  assert.deepEqual(
    await page.locator(".summary-cards .metric > span").allTextContents(),
    [
      "Opening Balance",
      "Closing Balance",
      "Total Distance",
      "Total Time",
      "Fuel Cost",
    ]
  );
  assert.match(
    await page.locator(".summary-cards .metric").first().innerText(),
    /1,000/
  );

  assert.equal(await page.locator("select[name=start]").count(), 0);
  assert.equal(
    await page.locator("[data-duty-location] > p").innerText(),
    "Connaught Place, New Delhi"
  );
  await page.waitForFunction(
    () => !document.querySelector("[data-refresh-location]").hidden
  );
  assert.doesNotMatch(
    await page.locator("[data-duty-location] > p").innerText(),
    /Latitude|Longitude|28\.6139|77\.209/
  );
  assert.equal(
    await page.getByRole("link", { name: "View location on map" }).count(),
    0
  );
  const vehicle = page.locator("[name=vehicle]");
  assert.equal(await vehicle.getAttribute("type"), "hidden");
  assert.equal(await vehicle.inputValue(), "PB31AB1234");
  assert.equal(
    await page
      .locator(
        "#duty-form [name=fuel], #duty-form input[type=checkbox], #document-help"
      )
      .count(),
    0
  );
  await page.locator("[data-add-vehicle]").click();
  await page.locator("#vehicle-dialog[open]").waitFor();
  assert.equal(await page.locator("#start-duty").isDisabled(), true);
  await page.locator("[data-cancel-vehicle]").first().click();
  assert.equal(await vehicle.inputValue(), "PB31AB1234");
  await page.locator("[data-add-vehicle]").click();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const text of [
      "Insurance Available",
      "PUC Available",
      "RC Available",
      "FASTag Available",
    ]) {
      const label = page
        .locator("#vehicle-form label.dsr-checkbox-option")
        .filter({ hasText: text });
      assert.equal(await label.isVisible(), true);
      const style = await label.locator("span").evaluate((el) => ({
        color: getComputedStyle(el).color,
        fontSize: getComputedStyle(el).fontSize,
        width: el.getBoundingClientRect().width,
      }));
      assert.ok(["rgb(17, 24, 39)", "rgb(0, 0, 0)"].includes(style.color));
      assert.ok(parseFloat(style.fontSize) >= 12);
      assert.ok(style.width > 20);
      await label.click();
      assert.equal(await label.locator("input").isChecked(), true);
      await label.click();
      assert.equal(await label.locator("input").isChecked(), false);
    }
  }
  const details = { registration_number: "MH12DE1433" };
  await page
    .getByLabel("Vehicle Number", { exact: true })
    .fill(details.registration_number);
  assert.equal(
    await page
      .locator(
        "#vehicle-form [name=vehicle_type], #vehicle-form [name=make], #vehicle-form [name=model]"
      )
      .count(),
    0
  );
  for (const key of ["insurance", "puc", "rc", "fastag"])
    await page
      .locator(`#vehicle-form input[type=checkbox][name=${key}_available]`)
      .check();
  await page.locator("#vehicle-form [name=fuel_type]").selectOption("Diesel");
  assert.equal(await page.locator("#vehicle-form input[type=date]").count(), 3);
  assert.deepEqual(
    await page.locator("#vehicle-form [name=status] option").allTextContents(),
    ["Active", "Inactive"]
  );
  await page
    .getByLabel("Insurance Expiry (optional)", { exact: true })
    .fill("2099-12-31");
  await page.getByRole("button", { name: "Save Vehicle", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector("[name=vehicle]").value === "MH12DE1433"
  );
  assert.deepEqual(added, {
    ...details,
    fuel_type: "Diesel",
    insurance_available: "1",
    puc_available: "1",
    rc_available: "1",
    fastag_available: "1",
    insurance_expiry: "2099-12-31",
    puc_expiry: "",
    rc_expiry: "",
    status: "Active",
  });
  assert.equal(await vehicle.inputValue(), "MH12DE1433");
  await page.locator("#duty-form [name=odometer_reading]").fill("1000");
  await page.locator("#duty-form [data-open-odometer]").click();
  await page.waitForFunction(
    () => document.querySelector("#duty-form video")?.videoWidth > 0
  );
  await page.locator("#duty-form [data-capture-odometer]").click();
  await page.locator("#duty-form [data-odometer-camera] img").waitFor();

  assert.equal(
    await page
      .getByRole("button", { name: "Duty ON", exact: true })
      .isDisabled(),
    false
  );
  for (const mode of ["failure", "ip"]) {
    failLookup = mode === "failure";
    ipLookup = mode === "ip";
    await page.evaluate(() =>
      document.querySelector("[data-refresh-location]").click()
    );
    await page
      .getByText(
        "Location captured. Address is unavailable. Tap Refresh Location to retry."
      )
      .waitFor();
    assert.doesNotMatch(
      await page.locator("[data-duty-location] > p").innerText(),
      /28\.6139|77\.209/
    );
  }
  failLookup = false;
  ipLookup = false;
  await page.evaluate(() => (window.denyLocation = true));
  await page.evaluate(() =>
    document.querySelector("[data-refresh-location]").click()
  );
  await page
    .getByText(/Location permission is blocked/)
    .first()
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Duty ON", exact: true })
      .isDisabled(),
    true
  );
  await page.evaluate(() => (window.denyLocation = false));
  await page.evaluate(() =>
    document.querySelector("[data-refresh-location]").click()
  );
  await page.getByText("Connaught Place, New Delhi").waitFor();
  const calls = await page.evaluate(() => window.locationCalls);
  const posted = page.waitForResponse((r) => r.url().endsWith(".duty_on"));
  await page.getByRole("button", { name: "Duty ON", exact: true }).click();
  await posted;
  assert.ok(submitted);
  assert.equal(submitted.start_location, "Current Location");
  assert.equal(submitted.vehicle_number, "MH12DE1433");
  assert.equal(submitted.odometer_start, "1000");
  assert.equal(submitted.odometer_photo.challenge, "starting-odometer-token");
  assert.equal(submitted.fuel_type, undefined);
  assert.equal(submitted.documents, undefined);
  assert.equal(submitted.gps.latitude, 28.6139);
  assert.equal(submitted.gps.longitude, 77.209);
  assert.equal(submitted.gps.accuracy, 5000);
  assert.equal((await page.evaluate(() => window.locationCalls)) > calls, true);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "PASS: area/city display without coordinates; lookup failures and IP fallback rejected; refresh; GPS denial blocks duty; original GPS submitted. Simulated GPS/geocoding fixtures; no live provider requests."
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
