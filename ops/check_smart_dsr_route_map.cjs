const { chromium } = require("playwright");
const fs = require("fs");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();
  const path = require("path");
  const root = path.resolve(__dirname, "../srv_erp/public/smart_dsr") + "/";
  const leaflet =
    path.resolve(__dirname, "../../frappe/frappe/public/js/lib/leaflet") + "/";
  let empty = false,
    requests = 0;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const record = {
    doctype: "DSR Duty Session",
    name: "test-duty",
    account: "sales@test.invalid",
    status: "Active",
    vehicle_number: "PB31AB1234",
    verified_km: 2,
    estimated_km: 2.5,
  };
  const points = [
    {
      latitude: 28,
      longitude: 77,
      accuracy: 5,
      captured_at: "2026-11-17T09:00:00+05:30",
      verified: 1,
    },
    {
      latitude: 28.005,
      longitude: 77.005,
      accuracy: 5,
      captured_at: "2026-11-17T09:01:00+05:30",
      verified: 1,
    },
    {
      latitude: 28.01,
      longitude: 77.01,
      accuracy: 200,
      captured_at: "2026-11-17T09:11:00+05:30",
      verified: 0,
    },
    {
      latitude: 28.015,
      longitude: 77.015,
      accuracy: 200,
      captured_at: "2026-11-17T09:12:00+05:30",
      verified: 0,
    },
  ];
  await page.route("**/api/method/**", (r) => {
    let result = {};
    const method = r.request().url().split(".").pop();
    if (method === "bootstrap")
      result = {
        user: "Administrator",
        today: "2026-11-17",
        users: [],
        currency: "INR",
      };
    if (method === "list_records") result = { rows: [record], total: 1 };
    if (method === "details") result = { record };
    if (method === "duty_route") {
      requests++;
      result = {
        ...record,
        duty: "test-duty",
        points: empty ? [] : points,
        segments: empty
          ? []
          : [
              {
                kind: "verified",
                coordinates: [
                  [28, 77],
                  [28.005, 77.005],
                ],
              },
              {
                kind: "approximate",
                coordinates: [
                  [28.01, 77.01],
                  [28.015, 77.015],
                ],
              },
            ],
        gaps: empty
          ? []
          : [
              {
                latitude: 28.01,
                longitude: 77.01,
                reason: "Tracking gap",
                from: points[1].captured_at,
                to: points[2].captured_at,
              },
            ],
        visits: empty
          ? []
          : [
              {
                customer: 'Dealer <img src=x onerror="window.hacked=1">',
                latitude: 28.005,
                longitude: 77.005,
                status: "Completed",
              },
            ],
      };
    }
    return r.fulfill({ json: { message: result } });
  });
  await page.route("https://tile.openstreetmap.org/**", (r) =>
    r.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
        "base64"
      ),
    })
  );
  const observe = `window.routeLines=[];const orig=L.polyline;L.polyline=(coords,options)=>{window.routeLines.push({coords,options});return orig(coords,options)};`;
  await page.route("**/route-admin", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fs.readFileSync(
        leaflet + "leaflet.css",
        "utf8"
      )}${fs.readFileSync(
        root + "admin.css",
        "utf8"
      )}</style></head><body><div id="dsr-admin"></div><script>window.dsr_admin_csrf='test'</script><script>${fs.readFileSync(
        leaflet + "leaflet.js",
        "utf8"
      )}</script><script>${observe}</script><script>${fs.readFileSync(
        root + "route-map.js",
        "utf8"
      )}</script><script>${fs.readFileSync(
        root + "admin.js",
        "utf8"
      )}</script></body></html>`,
    })
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("http://127.0.0.1:8001/route-admin#duties");
    await page.reload();
    await page
      .getByRole("button", { name: "View Details", exact: true })
      .click();
    await page.getByText(/4 GPS points/).waitFor();
    assert.equal(await page.locator(".leaflet-container").count(), 1);
    assert.equal(await page.evaluate(() => window.routeLines.length), 2);
    assert.equal(
      await page.evaluate(() => window.routeLines[0].options.color),
      "#2563eb"
    );
    assert.equal(
      await page.evaluate(() => window.routeLines[1].options.dashArray),
      "7 7"
    );
    assert.equal(await page.evaluate(() => window.hacked), undefined);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      ),
      true
    );
    await page
      .getByRole("button", { name: "Show Full Route", exact: true })
      .click();
    const before = requests;
    await page
      .getByRole("button", { name: "Refresh Route", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector("[data-route-refresh]").disabled
    );
    assert(requests > before);
    await page.screenshot({
      path: `/tmp/smart-dsr-screenshots/route-${width}.png`,
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".leaflet-map-pane").length === 0
    );
  }
  empty = true;
  await page.getByRole("button", { name: "View Details", exact: true }).click();
  await page.getByText(/No GPS route recorded/).waitFor();
  assert.equal(await page.locator("[data-route-map]").isVisible(), false);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "Admin route map: desktop/mobile, verified/approximate paths, gap handling, refresh, safe popups, cleanup and empty state passed"
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
