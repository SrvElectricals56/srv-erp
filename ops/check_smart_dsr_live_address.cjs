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
    await page.addInitScript(() => {
      window.fixes = 0;
      Object.defineProperty(navigator, "geolocation", {
        value: {
          getCurrentPosition(ok) {
            window.fixes++;
            ok({ coords: { latitude: 29.99, longitude: 75.39, accuracy: 20 } });
          },
          watchPosition() {
            return 1;
          },
          clearWatch() {},
        },
      });
    });
    let failed = false,
      ip = false,
      detail = "none";
    await page.route("https://photon.komoot.io/reverse?*", (r) => {
      const url = new URL(r.request().url());
      assert.equal(url.searchParams.get("lat"), "29.99");
      assert.equal(url.searchParams.get("lon"), "75.39");
      if (detail === "failed") return r.fulfill({ status: 503, json: {} });
      return r.fulfill({
        json: {
          features:
            detail === "none"
              ? []
              : [
                  {
                    geometry: {
                      coordinates:
                        detail === "distant" ? [76.39, 30.99] : [75.39, 29.99],
                    },
                    properties: {
                      ...(detail === "residential"
                        ? {
                            name: "Green Valley",
                            osm_key: "landuse",
                            osm_value: "residential",
                          }
                        : {
                            street: "Green Valley Road",
                            district: "Green Valley",
                          }),
                      city: "Mansa",
                      county: "Mansa district",
                      locality: "Mansa tehsil",
                      state: "Punjab",
                      postcode: "151505",
                      country: "India",
                    },
                  },
                ],
        },
      });
    });
    await page.route(
      "https://api.bigdatacloud.net/data/reverse-geocode-client?*",
      (r) => {
        const url = new URL(r.request().url());
        assert.equal(url.searchParams.get("latitude"), "29.99");
        assert.equal(url.searchParams.get("longitude"), "75.39");
        return r.fulfill(
          failed
            ? { status: 503, json: {} }
            : {
                json: {
                  locality: "Mansa",
                  city: "mansa",
                  principalSubdivision: "Punjab",
                  postcode: "151505",
                  countryName: "India",
                  lookupSource: ip ? "IP geolocation" : "reverseGeocoding",
                  localityInfo: {
                    administrative: [
                      { name: "Mansa District", description: "district" },
                      { name: "Mansa tehsil", description: "subdistrict" },
                    ],
                  },
                },
              }
        );
      }
    );
    await page.route("**/api/method/srv_erp.smart_dsr.api.*", (r) =>
      r.fulfill({
        json: {
          message: {
            account: "user",
            employee_name: "User",
            vehicles: [],
            current: null,
            territories: [],
          },
        },
      })
    );
    const source = fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/smart_dsr/app.js"),
      "utf8"
    );
    await page.route("**/address-test", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<meta charset="utf-8"><div id="smart-dsr"></div><script>${source}</script>`,
      })
    );
    await page.goto("http://localhost/address-test");
    const target = page.locator("[data-duty-location]");
    await page
      .getByText("Mansa, Mansa District, Punjab, 151505, India", {
        exact: true,
      })
      .waitFor();
    assert.doesNotMatch(
      await target.innerText(),
      /29\.99|75\.39|latitude|longitude/i
    );
    const refresh = page.getByRole("button", {
      name: "Refresh Location",
      exact: true,
    });
    assert.equal(await refresh.isVisible(), true);
    const before = await page.evaluate(() => window.fixes);
    await refresh.click();
    await page.waitForFunction(
      () => !document.querySelector("[data-refresh-location]").disabled
    );
    assert.ok((await page.evaluate(() => window.fixes)) > before);
    detail = "precise";
    await refresh.click();
    await page
      .getByText(
        "Green Valley, Green Valley Road, Mansa, Mansa district, Punjab, 151505, India",
        { exact: true }
      )
      .waitFor();
    assert.equal(
      await page
        .getByText("Address © OpenStreetMap contributors", { exact: true })
        .count(),
      0
    );
    await page.waitForFunction(
      () => !document.querySelector("[data-refresh-location]").disabled
    );
    detail = "residential";
    await refresh.click();
    await page
      .getByText("Green Valley, Mansa, Mansa district, Punjab, 151505, India", {
        exact: true,
      })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector("[data-refresh-location]").disabled
    );
    for (detail of ["distant", "failed"]) {
      await refresh.click();
      await page
        .getByText("Mansa, Mansa District, Punjab, 151505, India", {
          exact: true,
        })
        .waitFor();
      await page.waitForFunction(
        () => !document.querySelector("[data-refresh-location]").disabled
      );
    }
    detail = "none";
    for (const mode of ["failed", "ip"]) {
      failed = mode === "failed";
      ip = mode === "ip";
      await refresh.click();
      await page
        .getByText(
          "Location captured. Address is unavailable. Tap Refresh Location to retry.",
          { exact: true }
        )
        .waitFor();
      assert.doesNotMatch(await target.innerText(), /29\.99|75\.39/);
      await page.waitForFunction(
        () => !document.querySelector("[data-refresh-location]").disabled
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: detailed live place name; duplicate city removed; no visible coordinates; refresh obtains new GPS; provider failure and IP results do not show a false address. Mocked GPS/provider fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
