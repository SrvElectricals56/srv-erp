// Isolated dialog contract: no site, session, or payment writes.
const assert = require("assert/strict");
const fs = require("fs");
const vm = require("vm");
const path = require("path");

(async () => {
  let current,
    active = false,
    route,
    pending,
    fail = false;
  const requests = [],
    messages = [];
  class Dialog {
    constructor(config) {
      Object.assign(this, config);
      this.button = {
        prop(key, value) {
          this[key] = value;
          return this;
        },
        text(value) {
          this.label = value;
          return this;
        },
      };
      this.status = {
        html(value) {
          this.value = value;
        },
      };
      this.fields_dict = { save_status: { $wrapper: this.status } };
      current = this;
    }
    show() {}
    hide() {
      this.hidden = true;
    }
    get_primary_btn() {
      return this.button;
    }
  }
  const context = {
    srv_erp: { home_collections: {} },
    crypto: require("crypto").webcrypto,
    __: (text) => text,
    frappe: {
      provide() {},
      ui: { Dialog },
      utils: { escape_html: (value) => value.replaceAll("<", "&lt;") },
      set_route: (value) => {
        route = value;
      },
      msgprint: (value) => messages.push(value),
      show_alert: (value) => messages.push(value),
      xcall: async (method, args) => {
        if (method.endsWith("options"))
          return { duty: active ? "duty" : null, currency: "INR" };
        requests.push(args);
        if (fail)
          throw {
            responseJSON: {
              _server_messages: JSON.stringify([
                JSON.stringify({ message: "Dealer access denied" }),
              ]),
            },
          };
        return new Promise((resolve) => {
          pending = resolve;
        });
      },
    },
  };
  context.frappe.call = ({ method, args, callback, error }) => {
    context.frappe
      .xcall(method, args)
      .then((message) => callback({ message }), error);
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, "../srv_erp/public/js/home_collections.js"),
      "utf8"
    ),
    context
  );
  const collect = context.srv_erp.home_collections.collect;
  await collect();
  assert.equal(current.primary_action_label, "Save Collection");
  assert.equal(requests.length, 0);
  const values = {
    customer: "Dealer",
    value: 500,
    payment_method: "Cheque",
    transaction_reference: "CHQ-1",
  };
  const save = current.primary_action(values);
  assert.equal(current.button.label, "Saving…");
  assert.equal(current.button.disabled, true);
  assert.match(current.status.value, /Saving collection/);
  await current.primary_action(values);
  assert.equal(requests.length, 1);
  pending({ name: "receipt", balance: 1500 });
  await save;
  assert.equal(current.hidden, true);
  await collect();
  fail = true;
  await current.primary_action(values);
  assert.match(current.status.value, /Dealer access denied/);
  assert.equal(current.button.disabled, false);
  const key = requests.at(-1).request_key;
  await current.primary_action(values);
  assert.equal(requests.at(-1).request_key, key);
  assert.equal(current.hidden, undefined);
  console.log(
    "PASS: collection without duty, saving feedback, duplicate-click protection, success, visible errors and stable retry key."
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
