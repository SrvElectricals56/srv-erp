const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
let route = ['smart-dsr'], displayed = [], standardCalls = 0;
const events = {}, innerEvents = {};
const frame = {
  contentWindow: { location: { hash: '#balances' }, addEventListener: (name, fn) => innerEvents[name] = fn },
  addEventListener: (name, fn) => events[name] = fn,
  getAttribute() { return this.src; },
};
const page = { main: { addClass() {}, append() {} }, set_title() {}, set_secondary_action() {}, clear_secondary_action() {} };
const breadcrumbs = {
  all: {},
  set_custom_breadcrumbs() { standardCalls++; },
  append_breadcrumb_element(href, label) { displayed.push({ href, label }); },
  add(value) { this.all[route.join('/')] = value; this.update(); },
  update() { displayed = []; this.set_custom_breadcrumbs(this.all[route.join('/')]); },
};
const context = {
  URLSearchParams, __: value => value,
  window: { location: { pathname: '/app/smart-dsr', search: '?section=expenses', hash: '' }, history: { length: 1 } },
  document: { createElement: () => frame },
  frappe: { pages: { 'smart-dsr': {} }, get_route: () => route, breadcrumbs, route_options: {}, ui: { make_app_page: () => page } },
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../srv_erp/srv_erp/page/smart_dsr/smart_dsr.js'), 'utf8'), context);
const wrapper = { page };
const handlers = context.frappe.pages['smart-dsr'];
handlers.on_page_load(wrapper);
handlers.on_page_show(wrapper);
assert.deepEqual(displayed.map(x => x.label), ['Home', 'Smart DSR', 'Expenses']);
breadcrumbs.update(); // Frappe redraws breadcrumbs after showing a page.
assert.deepEqual(displayed.map(x => x.label), ['Home', 'Smart DSR', 'Expenses']);
route = ['smart-dsr', 'admin'];
handlers.on_page_show(wrapper);
events.load();
assert.deepEqual(displayed.map(x => x.label), ['Home', 'Smart DSR Admin', 'Opening Balances']);
assert.equal(displayed[2].href, '/app/smart-dsr/admin#balances');
frame.contentWindow.location.hash = '#people';
innerEvents.hashchange();
assert.deepEqual(displayed.map(x => x.label), ['Home', 'Smart DSR Admin', 'Salespersons']);
handlers.on_page_show(wrapper);
assert.equal(displayed[2].label, 'Salespersons');
route = ['Form', 'User', 'test'];
innerEvents.hashchange();
assert.equal(displayed[2].label, 'Salespersons'); // Hidden frame cannot alter another page.
breadcrumbs.set_custom_breadcrumbs({ type: 'Custom', label: 'Existing custom breadcrumb' });
assert.equal(standardCalls, 1);
console.log('PASS: salesperson sections, admin navigation, redraws, return navigation and existing custom breadcrumbs.');
