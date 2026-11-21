/* Browser checks for the manual overdue register using Frappe and API fixtures. */
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
    const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
      }),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const bench = path.resolve(__dirname, "../../.."),
      source = path.join(__dirname, "../srv_erp/srv_erp/page/overdues");
    await page.route("http://localhost/overdues-test", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="actions"></div><div id="wrapper"></div>',
      })
    );
    await page.goto("http://localhost/overdues-test");
    await page.addScriptTag({
      path: bench + "/apps/frappe/frappe/public/js/lib/jquery/jquery.min.js",
    });
    const assets = JSON.parse(
      fs.readFileSync(bench + "/sites/assets/assets.json", "utf8")
    );
    await page.addStyleTag({
      path: bench + "/sites" + assets["desk.bundle.css"],
    });
    await page.addStyleTag({ path: source + "/overdues.css" });
    await page.evaluate(() => {
      window.__ = (text) => text;
      window.format_currency = (value, currency) =>
        currency + " " + Number(value).toFixed(2);
      const escape = (value) =>
        String(value).replace(
          /[&<>"']/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            }[c])
        );
      window.fixture = [];
      for (let i = 1; i <= 31; i++) {
        window.fixture.push({
          customer: "C-" + i,
          customer_name: i === 1 ? "Green Valley Dealer" : "Dealer " + i,
          territory: "Punjab",
          sales_person: "Sales User",
          voucher_no: "DUE-" + i,
          voucher_type: "Dealer Overdue",
          reference_no: "REF-" + i,
          posting_date: "2026-09-01",
          due_date: i === 1 ? "2026-07-12" : "2026-10-01",
          days_overdue: i === 1 ? 130 : 49,
          amount: 150,
          paid: 50,
          outstanding: 100,
          overdue: 100,
        });
      }
      const dealer = window.fixture[0];
      window.fixture.push({
        ...dealer,
        voucher_no: "DUE-32",
        reference_no: "REF-32",
        amount: 75,
        paid: 25,
        outstanding: 50,
        overdue: 50,
      });
      window.fixture.push({
        ...dealer,
        voucher_no: "DUE-33",
        reference_no: "SETTLED",
        amount: 20,
        paid: 20,
        outstanding: 0,
        overdue: 0,
      });
      window.fixture.push({
        ...dealer,
        voucher_no: "DUE-34",
        reference_no: "DUE-TODAY",
        amount: 30,
        paid: 0,
        outstanding: 30,
        overdue: 0,
        days_overdue: 0,
        due_date: "2026-11-19",
      });
      function control({ parent, df }) {
        const $wrapper = $('<div class="frappe-control"></div>').appendTo(
          parent
        );
        if (df.fieldtype === "Button") {
          $("<button></button>")
            .text(df.label)
            .on("click", df.click)
            .appendTo($wrapper);
          return { df, $wrapper };
        }
        if (df.fieldtype === "HTML") return { df, $wrapper };
        const $label = $("<label></label>").text(df.label).appendTo($wrapper);
        const $input = $(
          df.fieldtype === "Select" ? "<select></select>" : "<input>"
        )
          .attr({ "aria-label": df.label, "data-fieldname": df.fieldname })
          .appendTo($label);
        if (df.options && df.fieldtype === "Select")
          df.options
            .split("\n")
            .forEach((text) =>
              $("<option></option>").text(text).appendTo($input)
            );
        if (df.default !== undefined) $input.val(df.default);
        const instance = {
          df,
          $wrapper,
          $input,
          get_value: () => $input.val(),
          set_value: async (value) => {
            $input.val(value);
            df.change?.();
          },
        };
        $input.on("change", () => {
          df.change?.();
          df.onchange?.();
        });
        return instance;
      }
      class FieldGroup {
        constructor(options) {
          Object.assign(this, options);
          this.fields_dict = {};
        }
        make() {
          for (const df of this.fields)
            if (df.fieldname)
              this.fields_dict[df.fieldname] = control({
                parent: this.body,
                df,
              });
        }
        get_value(key) {
          return this.fields_dict[key].get_value();
        }
        get_values() {
          const data = {};
          for (const [key, c] of Object.entries(this.fields_dict))
            if (c.get_value) data[key] = c.get_value();
          if (!data.report_date)
            window.missingDateCalls = (window.missingDateCalls || 0) + 1;
          return data.report_date ? data : null;
        }
        async set_value(key, value) {
          if (key === "report_date")
            await new Promise((resolve) => setTimeout(resolve, 30));
          return this.fields_dict[key].set_value(value);
        }
      }
      class Dialog extends FieldGroup {
        constructor(options) {
          const $root = $('<div role="dialog"></div>').appendTo("body");
          $("<h3></h3>").text(options.title).appendTo($root);
          super({ ...options, body: $root });
          this.$root = $root;
          this.make();
          if (options.primary_action) {
            this.set_primary_action(options.primary_action_label, () => {
              const values = {};
              for (const [key, field] of Object.entries(this.fields_dict)) {
                if (field.get_value) values[key] = field.get_value();
                if (field.df.reqd && !values[key]) return;
              }
              options.primary_action(values);
            });
          }
        }
        set_primary_action(label, fn) {
          this.$primary = $("<button></button>")
            .text(label)
            .on("click", fn)
            .appendTo(this.$root);
        }
        disable_primary_action() {
          this.$primary.prop("disabled", true);
        }
        enable_primary_action() {
          this.$primary.prop("disabled", false);
        }
        show() {}
        hide() {
          this.$root.remove();
        }
      }
      window.createCalls = [];
      window.frappe = {
        pages: { overdues: {} },
        provide(name) {
          let o = window;
          for (const key of name.split(".")) o = o[key] ||= {};
        },
        utils: {
          escape_html: escape,
          debounce(fn) {
            return fn;
          },
        },
        router: { slug: (s) => s.toLowerCase().replace(/ /g, "-") },
        datetime: {
          get_today: () => "2026-11-19",
          str_to_user: (value) => value,
        },
        ui: {
          FieldGroup,
          Dialog,
          form: { make_control: control },
          make_app_page({ parent }) {
            const action = (label, fn) =>
              $("<button></button>")
                .text(label)
                .on("click", fn)
                .appendTo("#actions");
            return {
              body: parent,
              set_primary_action: action,
              set_secondary_action: action,
              add_inner_button: action,
            };
          },
        },
        async call({ method, args }) {
          if (method === "srv_erp.overdues.get_dealer_details")
            return {
              message: {
                sales_person:
                  args.customer === "C-1"
                    ? "Allocated Sales Person"
                    : "Other Sales Person",
              },
            };
          if (method === "srv_erp.overdues.get_entry_options") {
            if (window.banCreate) {
              window.lastMessage =
                "You do not have permission to create manual overdue entries.";
              throw Error("permission denied");
            }
            return { message: { company: "SRV Electricals", currency: "INR" } };
          }
          if (method === "srv_erp.overdues.record_received_amount") {
            (window.receiptCalls ||= []).push(args);
            if (window.failReceipt) {
              window.failReceipt = false;
              throw Error("receipt fixture failure");
            }
            let remaining = Number(args.amount);
            for (const row of window.fixture
              .filter(
                (row) => row.customer === args.customer && row.outstanding > 0
              )
              .sort((a, b) => a.due_date.localeCompare(b.due_date))) {
              const applied = Math.min(remaining, row.outstanding);
              row.paid += applied;
              row.outstanding -= applied;
              row.overdue = row.days_overdue > 0 ? row.outstanding : 0;
              remaining -= applied;
              if (remaining <= 0) break;
            }
            return { message: "DUE-REC-1" };
          }
          if (method === "srv_erp.overdues.create_overdue") {
            window.createCalls.push(args);
            if (window.failCreate) {
              window.failCreate = false;
              throw Error("fixture create failure");
            }
            const values = args.values;
            const outstanding =
              Number(values.amount) - Number(values.amount_received);
            const daysOverdue = Math.max(
              0,
              (Date.parse(frappe.datetime.get_today()) -
                Date.parse(values.due_date)) /
                86400000
            );
            const party = window.fixture.find(
              (row) => row.customer === values.customer
            );
            window.fixture.push({
              ...party,
              voucher_no: "DUE-35",
              reference_no: values.reference_no,
              remarks: values.remarks,
              amount: Number(values.amount),
              paid: Number(values.amount_received),
              outstanding,
              overdue: daysOverdue > 0 ? outstanding : 0,
              days_overdue: daysOverdue,
              due_date: values.due_date,
              posting_date: values.entry_date,
            });
            return { message: "DUE-35" };
          }
          if (method !== "srv_erp.overdues.get_overdues")
            throw Error("Unexpected method: " + method);
          window.lastArgs = args;
          if (window.failNext) {
            window.failNext = false;
            throw Error("fixture refresh failure");
          }
          const rows = window.fixture.filter(
            (row) => !args.customer || row.customer === args.customer
          );
          return {
            message: {
              rows,
              company: "SRV Electricals",
              report_date: args.report_date,
              currency: "INR",
              generated_at: "2026-11-19 10:00:00",
              can_create: !window.banCreate,
              can_receive: true,
              can_export: true,
              can_print: true,
            },
          };
        },
        msgprint(text) {
          window.lastMessage = text;
        },
        set_route(...args) {
          window.lastRoute = args;
        },
        show_alert({ message }) {
          window.lastAlert = message;
        },
      };
    });
    await page.addScriptTag({ path: source + "/overdues.js" });
    await page.evaluate(() =>
      frappe.pages.overdues.on_page_load(document.querySelector("#wrapper"))
    );
    const root = page.locator(".overdues-page");
    await root.locator("tbody tr").first().waitFor();
    assert.equal(await page.evaluate(() => window.missingDateCalls || 0), 0);
    assert.equal(
      await root.getByLabel("Ageing Date", { exact: true }).inputValue(),
      "2026-11-19"
    );
    assert.equal(await root.getByLabel("Company", { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.lastArgs.company), undefined);
    const metric = (label) =>
      root
        .locator(".overdues-metric")
        .filter({ hasText: label })
        .locator("strong");
    assert.equal(await metric("Total Amount").textContent(), "INR 4775.00");
    assert.equal(await metric("Received").textContent(), "INR 1595.00");
    assert.equal(
      await metric("Remaining Balance").textContent(),
      "INR 3180.00"
    );
    assert.equal(await metric("Overdue").textContent(), "INR 3150.00");
    assert.equal(await root.locator("tbody tr").count(), 25);
    assert.equal(
      await root
        .locator("tbody")
        .getByRole("button", { name: "Add Received Amount", exact: true })
        .count(),
      0
    );
    await root.getByRole("button", { name: "Next", exact: true }).click();
    assert.equal(await root.locator("tbody tr").count(), 6);
    await root.getByRole("button", { name: "Previous", exact: true }).click();

    await root
      .getByRole("button", { name: "View balances", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.innerText(), /INR 180.00/);
    assert.match(await dialog.innerText(), /SETTLED/);
    assert.match(await dialog.innerText(), /DUE-TODAY/);
    assert.equal(
      await dialog
        .getByRole("link", { name: "DUE-1", exact: true })
        .getAttribute("href"),
      "/app/dealer-overdue/DUE-1"
    );
    await dialog
      .getByRole("button", { name: "Add Overdue", exact: true })
      .click();
    assert.equal(
      await dialog.getByLabel("Dealer / Party", { exact: true }).inputValue(),
      "C-1"
    );
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[role="dialog"] [data-fieldname="sales_person"]'
        ).value === "Allocated Sales Person"
    );
    await dialog.getByLabel("Dealer / Party", { exact: true }).fill("C-2");
    await dialog
      .getByLabel("Dealer / Party", { exact: true })
      .dispatchEvent("change");
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[role="dialog"] [data-fieldname="sales_person"]'
        ).value === "Other Sales Person"
    );
    await dialog.getByLabel("Dealer / Party", { exact: true }).fill("C-1");
    await dialog
      .getByLabel("Dealer / Party", { exact: true })
      .dispatchEvent("change");
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[role="dialog"] [data-fieldname="sales_person"]'
        ).value === "Allocated Sales Person"
    );
    await dialog.getByLabel("Total Amount", { exact: true }).fill("200");
    await dialog.getByLabel("Amount Received", { exact: true }).fill("80");
    await dialog.getByLabel("Due Date", { exact: true }).fill("2026-10-20");
    await dialog
      .getByLabel("Bill / Reference Number", { exact: true })
      .fill("MANUAL-REF");
    await dialog.getByLabel("Remarks", { exact: true }).fill("Manager balance");
    const save = dialog.getByRole("button", {
      name: "Save Overdue",
      exact: true,
    });
    await page.evaluate(() => (window.failCreate = true));
    await save.click();
    assert.equal(
      await dialog.getByLabel("Total Amount", { exact: true }).inputValue(),
      "200"
    );
    await save.click();
    await page.waitForFunction(
      () => window.lastAlert === "Manual overdue entry saved."
    );
    assert.equal(await dialog.count(), 1);
    for (const label of [
      "Dealer / Party",
      "Sales Person",
      "Total Amount",
      "Bill / Reference Number",
      "Remarks",
    ])
      assert.equal(
        await dialog.getByLabel(label, { exact: true }).inputValue(),
        ""
      );
    assert.equal(
      await dialog.getByLabel("Amount Received", { exact: true }).inputValue(),
      "0"
    );
    assert.equal(
      await dialog.getByLabel("Record Date", { exact: true }).inputValue(),
      "2026-11-19"
    );
    assert.equal(
      await dialog.getByLabel("Due Date", { exact: true }).inputValue(),
      "2026-11-19"
    );

    const calls = await page.evaluate(() => window.createCalls);
    assert.equal(calls.length, 2);
    assert.match(calls[0].request_key, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[1].values.customer, "C-1");
    assert.equal(calls[1].values.amount, "200");
    assert.equal(calls[1].values.amount_received, "80");
    assert.equal(calls[1].values.reference_no, "MANUAL-REF");
    assert.equal(
      await metric("Remaining Balance").textContent(),
      "INR 3300.00"
    );
    await dialog.getByLabel("Dealer / Party", { exact: true }).fill("C-2");
    await dialog.getByLabel("Total Amount", { exact: true }).fill("10");
    await page.evaluate(() => (window.failCreate = true));
    await save.click();
    await page.waitForFunction(() => window.createCalls.length === 3);
    assert.notEqual(
      await page.evaluate(() => window.createCalls[2].request_key),
      calls[1].request_key
    );
    await dialog.evaluate((el) => el.remove());

    const search = root.getByLabel("Search", { exact: true });
    const balanceStatus = root.getByLabel("Balance Status", { exact: true });
    await search.fill("Green Valley");
    assert.equal(await root.locator("tbody tr").count(), 1);
    await root
      .getByLabel("View", { exact: true })
      .selectOption("Manual Entries");
    assert.equal(await root.locator("tbody tr").count(), 5);
    await balanceStatus.selectOption("Paid");
    assert.equal(await root.locator("tbody tr").count(), 1);
    assert.match(await root.locator("tbody").innerText(), /SETTLED/);
    await balanceStatus.selectOption("Pending");
    assert.match(await root.locator("tbody").innerText(), /DUE-TODAY/);
    await balanceStatus.selectOption("All entries");
    await root.getByRole("button", { name: /120\+ days/ }).click();
    assert.equal(await root.locator("tbody tr").count(), 2);
    const minimum = root.getByLabel("Minimum amount", { exact: true });
    await minimum.fill("75");
    await minimum.dispatchEvent("change");
    assert.equal(await root.locator("tbody tr").count(), 1);
    await search.fill("nothing matches");
    await root.getByText(/No manual entries match these filters/).waitFor();
    await root
      .getByRole("button", { name: "Clear search / ageing", exact: true })
      .click();
    assert.equal(await root.locator("tbody tr").count(), 25);
    await search.fill("MANUAL-REF");
    assert.equal(await root.locator("tbody tr").count(), 1);
    assert.match(await root.locator("tbody").innerText(), /DUE-35/);

    await root.getByLabel("Dealer / Party", { exact: true }).fill("C-1");
    await root
      .getByRole("button", { name: "Apply Filters", exact: true })
      .click();
    await page.waitForFunction(() => window.lastArgs.customer === "C-1");
    for (const label of ["Manual Register", "Export CSV", "Print"]) {
      assert.equal(
        await page.getByRole("button", { name: label, exact: true }).count(),
        0
      );
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await root.evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    );
    const beforeReceipt = await page.evaluate(() =>
      window.fixture
        .filter((row) => row.customer === "C-1")
        .reduce((sum, row) => sum + row.outstanding, 0)
    );
    await page
      .locator("#actions")
      .getByRole("button", { name: "Add Received Amount", exact: true })
      .click();
    await dialog.getByLabel("Dealer / Party", { exact: true }).fill("C-1");
    await dialog.getByLabel("Received Amount", { exact: true }).fill("50");
    await dialog
      .getByLabel("Payment Reference", { exact: true })
      .fill("PAY-TEST");
    await page.evaluate(() => (window.failReceipt = true));
    await dialog
      .getByRole("button", { name: "Save Received Amount", exact: true })
      .click();
    assert.equal(
      await dialog.getByLabel("Received Amount", { exact: true }).inputValue(),
      "50"
    );
    await dialog
      .getByRole("button", { name: "Save Received Amount", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        window.lastAlert === "Received amount saved and dealer balance updated."
    );
    assert.equal(await dialog.count(), 1);
    for (const label of [
      "Dealer / Party",
      "Received Amount",
      "Payment Reference",
      "Remarks",
    ])
      assert.equal(
        await dialog.getByLabel(label, { exact: true }).inputValue(),
        ""
      );
    assert.equal(
      await dialog.getByLabel("Received Date", { exact: true }).inputValue(),
      "2026-11-19"
    );
    assert.equal(
      await page
        .locator("#actions")
        .getByRole("button", { name: "Add Received Amount", exact: true })
        .evaluate((el) => el.classList.contains("btn-primary")),
      true
    );

    assert.equal(
      Number(
        (await metric("Remaining Balance").textContent()).replace("INR ", "")
      ),
      beforeReceipt - 50
    );
    const receiptCalls = await page.evaluate(() => window.receiptCalls);
    assert.equal(receiptCalls.length, 2);
    assert.equal(receiptCalls[0].request_key, receiptCalls[1].request_key);
    await dialog.getByLabel("Dealer / Party", { exact: true }).fill("C-2");
    await dialog.getByLabel("Received Amount", { exact: true }).fill("10");
    await page.evaluate(() => (window.failReceipt = true));
    await dialog
      .getByRole("button", { name: "Save Received Amount", exact: true })
      .click();
    await page.waitForFunction(() => window.receiptCalls.length === 3);
    assert.notEqual(
      await page.evaluate(() => window.receiptCalls[2].request_key),
      receiptCalls[1].request_key
    );
    await dialog.evaluate((el) => el.remove());

    await page.evaluate(() => (window.banCreate = true));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector("#wrapper").overdues.data?.can_create === false
    );
    const addButton = page
      .locator("#actions")
      .getByRole("button", { name: "Add Overdue", exact: true });
    if ((await addButton.isVisible()) && (await addButton.isEnabled())) {
      await addButton.click();
      assert.match(
        await page.evaluate(() => window.lastMessage),
        /permission to create/
      );
    }
    assert.equal(await dialog.count(), 0);
    await page.evaluate(() => (window.failNext = true));
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await root
      .getByText("Balances are unavailable. No old results are being shown.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await root.locator(".overdues-summary").textContent(), "");
    assert.deepEqual(errors, []);
    console.log(
      "PASS: manual entry, save retry, balances, paid and pending records, ageing, filters, pagination, receipt button label, simplified toolbar, permissions and refresh. Frappe/API fixtures."
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
