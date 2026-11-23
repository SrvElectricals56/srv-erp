/* Smart DSR administrator interface. Every operation is authorized on the server. */
(() => {
	"use strict";
	const root = document.getElementById("dsr-admin");
	if (window.self !== window.top) {
		root.addEventListener("click", (event) => {
			const link = event.target.closest("a[href]");
			if (link && new URL(link.href, location.href).pathname.startsWith("/app"))
				link.target = "_top";
		});
	}
	const nav = [
		["overview", "Overview"],
		["people", "Salespersons"],
		["balances", "Opening Balances"],
		["vehicles", "Vehicles"],
		["duties", "Duty Records"],
		["visits", "Party Visits"],
		["collections", "Collections"],
		["expenses", "Expenses"],
		["dsrs", "DSR Records"],
		["reports", "Reports"],
		["audit", "Audit Logs"],
	];
	const columns = {
		overview: [
			"employee_name",
			"duty_status",
			"closing_balance",
			"verified_km",
			"duty_minutes",
			"total_visits",
			"collections",
		],
		people: ["employee_name", "account", "smart_dsr_disabled", "duty_status"],
		balances: [
			"employee_name",
			"account",
			"opening_balance",
			"closing_balance",
			"duty_status",
		],
		vehicles: [
			"allocated_to_name",
			"registration_number",
			"fuel_type",
			"fastag_available",
			"insurance_expiry",
			"puc_expiry",
			"rc_expiry",
			"status",
			"added_by_name",
		],
		duties: [
			"account",
			"work_date",
			"status",
			"vehicle_number",
			"started_at",
			"ended_at",
			"duty_minutes",
			"verified_km",
			"closing_balance",
		],
		visits: [
			"visit_number",
			"customer",
			"account",
			"arrived_at",
			"departed_at",
			"travel_distance_km",
			"collections",
			"status",
		],
		collections: [
			"account",
			"customer",
			"collected_at",
			"amount",
			"payment_method",
			"verification_status",
		],
		expenses: ["account", "recorded_at", "category", "amount", "posting_status"],
		dsrs: [
			"name",
			"owner",
			"date",
			"sales_person",
			"docstatus",
			"opening_balance",
			"closing_balance",
			"km_travelled",
			"total_amount",
		],
		audit: [
			"actor",
			"affected_user",
			"action",
			"record_type",
			"record_id",
			"reason",
			"recorded_at",
		],
		gps: ["account", "duty", "event_type", "recorded_at", "details"],
		outstanding: [
			"name",
			"customer",
			"posting_date",
			"due_date",
			"outstanding_amount",
			"currency",
		],
		ledger: [
			"posting_time",
			"transaction_type",
			"amount",
			"dealer_details",
			"collection_details",
			"remarks",
		],
	};
	const reports = [
		"Salespersons",
		"Opening Balances",
		"Vehicles",
		"Duty Records",
		"Party Visits",
		"Collections",
		"Expenses",
		"DSR Records",
		"Daily",
		"Weekly",
		"Monthly",
		"Quarterly",
		"Dealer Visits",
		"Outstanding Dues",
		"Cash Balances",
		"GPS Exceptions",
	];
	const s = {
		page: nav.some(([id]) => id === location.hash.slice(1))
			? location.hash.slice(1)
			: "overview",
		profile: null,
		filters: {},
		sectionFilters: {},
		visitDealers: [],
		dealerCleanup: null,
		result: null,
		metrics: null,
		number: 1,
		busy: false,
		report: "Salespersons",
	};
	const esc = (v) =>
		String(v ?? "").replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
		);
	const title = (v) =>
		({
			account: "User / Salesperson",
			dealer_details: "Dealer",
			collection_details: "Collection Details",
			registration_number: "Vehicle Number",
			added_by_name: "Added By",
			allocated_to_name: "Allocated Salesperson",
			allocated_to: "Allocated Salesperson User",
			estimated_km: "Estimated Tracked KM",
			odometer_start: "Starting Meter (KM)",
			odometer_end: "Ending Meter (KM)",
			odometer_distance: "Meter Distance (KM)",
			odometer_start_photo: "Starting Meter Photo",
			odometer_end_photo: "Ending Meter Photo",
			odometer_start_captured_at: "Starting Meter Captured At",
			odometer_end_captured_at: "Ending Meter Captured At",
			odometer_start_sha256: "Starting Meter Photo Hash",
			odometer_end_sha256: "Ending Meter Photo Hash",
			odometer_required: "Meter Evidence Required",
			fastag_available: "FASTag Available",
			employee: "Employee ID",
			employee_name: "Salesperson",
			verified_km: "GPS KM",
			duty_minutes: "Duty Time",
			no_visit_duty: "Excluded — No Visits",
			counted_duties: "Counted Duties",
			no_visit_duties: "No-visit Duties",
			duty_off_reason: "Duty OFF Reason",
			activity_duration_minutes: "Visit Duration",
			travel_duration_seconds: "Travel Time",
			reward_near_seconds: "Verified Time Near Dealer",
			smart_dsr_disabled: "Smart DSR Access",
			docstatus: "Document Status",
			end_gps: "Last Available GPS before Duty OFF",
			start_gps: "Starting GPS Evidence",
			confirmed_puc: "PUC",
			confirmed_rc: "RC",
			confirmed_fastag: "FASTag",
			confirmed_insurance: "Insurance",
		}[v] ||
		v
			.replace(/_(seconds|minutes|hours)$/, "")
			.replace(/_/g, " ")
			.replace(/\b\w/g, (c) => c.toUpperCase()));
	function shortDate(value) {
		if (!value) return "—";
		const day = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
		if (day) return `${day[3]}-${day[2]}-${day[1].slice(-2)}`;
		const stamp = value instanceof Date ? value : new Date(String(value).replace(" ", "T"));
		if (Number.isNaN(stamp.getTime())) return String(value);
		return stamp
			.toLocaleDateString("en-GB", {
				timeZone: "Asia/Kolkata",
				day: "2-digit",
				month: "2-digit",
				year: "2-digit",
			})
			.replaceAll("/", "-");
	}
	const date = (value) => {
		if (!value) return "—";
		const stamp = value instanceof Date ? value : new Date(String(value).replace(" ", "T"));
		return Number.isNaN(stamp.getTime())
			? String(value)
			: `${shortDate(stamp)}, ${stamp.toLocaleTimeString("en-IN", {
					timeZone: "Asia/Kolkata",
					hour: "2-digit",
					minute: "2-digit",
					hour12: true,
			  })}`;
	};
	const isDateField = (key) =>
		/(?:_date|_expiry|_at)$/.test(key) ||
		["date", "creation", "modified", "posting_time"].includes(key);
	function parseDateInput(value) {
		const raw = value.trim();
		const text =
			/^\d{6}$/.test(raw) || /^\d{8}$/.test(raw)
				? `${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4)}`
				: raw;
		let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/),
			year,
			month,
			day;
		if (match) [, year, month, day] = match;
		else {
			match = text.match(/^(\d{2})[-/](\d{2})[-/](\d{2}|\d{4})$/);
			if (!match) return null;
			[, day, month, year] = match;
			if (year.length === 2) year = "20" + year;
		}
		const check = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
		return check.getUTCFullYear() === Number(year) &&
			check.getUTCMonth() === Number(month) - 1 &&
			check.getUTCDate() === Number(day)
			? `${year}-${month}-${day}`
			: null;
	}
	function dateControl(label, name, value, attrs) {
		const iso = value ? String(value).slice(0, 10) : "";
		return `<label>${esc(label)}<div class="admin-date-control" data-admin-date="${esc(
			name
		)}"><input type="hidden" name="${esc(name)}" data-date-value value="${esc(
			iso
		)}"><input type="text" data-date-display="${esc(name)}" aria-label="${esc(
			label
		)}" value="${
			iso ? esc(shortDate(iso)) : ""
		}" placeholder="DD-MM-YY" maxlength="10" inputmode="numeric" autocomplete="off" ${
			/\brequired\b/.test(attrs) ? "required" : ""
		}><button type="button" data-date-open aria-label="Choose ${esc(
			label
		)}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg></button><input type="date" data-date-native value="${esc(
			iso
		)}" tabindex="-1" aria-hidden="true"></div></label>`;
	}
	function bindDateInputs(container) {
		container.querySelectorAll("[data-admin-date]").forEach((box) => {
			if (box.dataset.bound) return;
			box.dataset.bound = "1";
			const stored = box.querySelector("[data-date-value]"),
				field = box.querySelector("[data-date-display]"),
				native = box.querySelector("[data-date-native]");
			let displayed = field.value;
			const sync = (normalize) => {
				if (field.value === displayed && stored.value) {
					field.setCustomValidity("");
					delete field.dataset.invalidDate;
					return;
				}
				const raw = field.value.trim(),
					iso = raw ? parseDateInput(raw) : "";
				const invalid = raw && !iso;
				stored.value = iso || "";
				native.value = iso || "";
				field.setCustomValidity(invalid ? "Use DD-MM-YY, for example 20-11-26." : "");
				if (invalid) field.dataset.invalidDate = "1";
				else delete field.dataset.invalidDate;
				if (normalize && !invalid) {
					field.value = iso ? shortDate(iso) : "";
					displayed = field.value;
				}
			};
			field.oninput = () => sync(false);
			field.onblur = () => sync(true);
			box.querySelector("[data-date-open]").onclick = () => {
				if (native.showPicker) native.showPicker();
				else {
					native.focus();
					native.click();
				}
			};
			native.onchange = () => {
				stored.value = native.value;
				field.value = native.value ? shortDate(native.value) : "";
				displayed = field.value;
				field.setCustomValidity("");
				delete field.dataset.invalidDate;
				box.closest("form")?.dispatchEvent(new Event("input", { bubbles: true }));
			};
		});
	}
	const duration = (seconds) => {
		if (seconds == null || seconds === "" || !Number.isFinite(Number(seconds))) return "—";
		const value = Math.max(0, Number(seconds));
		if (value > 0 && value < 60) return "<1 min";
		const minutes = Math.floor(value / 60),
			hours = Math.floor(minutes / 60),
			remaining = minutes % 60;
		return hours ? `${hours} hr${remaining ? ` ${remaining} min` : ""}` : `${minutes} min`;
	};
	const isDuration = (key) => /_(seconds|minutes|hours)$/.test(key);
	const durationValue = (key, value) =>
		duration(
			Number(value) * (key.endsWith("_hours") ? 3600 : key.endsWith("_minutes") ? 60 : 1)
		);
	const money = (v) =>
		v == null
			? "Not initialized"
			: new Intl.NumberFormat("en-IN", {
					style: "currency",
					currency: s.profile?.currency || "INR",
			  }).format(Number(v || 0));
	const btn = (text, action, extra = "") =>
		`<button type="button" data-action="${action}" ${extra}>${text}</button>`;
	const input = (label, name, value = "", attrs = "") => {
		if (attrs.includes('type="date"')) return dateControl(label, name, value, attrs);
		if (attrs.includes('list="dsr-users"')) {
			const required = /\brequired\b/.test(attrs);
			const users = [...s.profile.users];
			if (value && !users.some((user) => user.name === value))
				users.unshift({ name: value, full_name: value });
			return `<label>${esc(label)}<select name="${name}" aria-label="${esc(label)}" ${
				required ? "required" : ""
			}><option value="">${required ? "Select User" : "All Users"}</option>${users
				.map(
					(user) =>
						`<option value="${esc(user.name)}" ${
							user.name === value ? "selected" : ""
						}>${esc(
							user.full_name && user.full_name !== user.name
								? `${user.full_name} (${user.name})`
								: user.name
						)}</option>`
				)
				.join("")}</select></label>`;
		}
		return `<label>${label}<input name="${name}" value="${esc(value)}" ${attrs}></label>`;
	};
	const select = (label, name, items, value = "") =>
		`<label>${label}<select name="${name}" aria-label="${esc(label)}">${items
			.map((item) => {
				const [v, l] = Array.isArray(item) ? item : [item, item];
				return `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(
					l
				)}</option>`;
			})
			.join("")}</select></label>`;
	async function api(method, args = {}) {
		const response = await fetch("/api/method/srv_erp.smart_dsr.admin." + method, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Frappe-CSRF-Token": window.dsr_admin_csrf,
			},
			body: JSON.stringify(args),
		});
		const json = await response.json();
		if (!response.ok || json.exc) {
			let message = json.message || json.exc_type || "Request failed";
			try {
				const items = JSON.parse(json._server_messages || "[]");
				if (items.length) message = JSON.parse(items[0]).message;
			} catch (_) {
				// Keep the fallback when optional cached data or error details are unavailable.
			}
			throw Error(String(message).replace(/<[^>]*>/g, ""));
		}
		return json.message;
	}
	async function run(fn) {
		if (s.busy) return;
		s.busy = true;
		root.setAttribute("aria-busy", "true");
		try {
			await fn();
		} catch (e) {
			showError(e.message);
		} finally {
			s.busy = false;
			root.removeAttribute("aria-busy");
		}
	}
	function showError(message) {
		const box = root.querySelector("#admin-message");
		if (box) {
			box.hidden = false;
			box.textContent = message;
			box.scrollIntoView({ block: "nearest" });
		} else root.textContent = message;
	}
	function success(result) {
		showError(
			`${
				result.outcome === "Review requested"
					? "Correction requested; original record unchanged."
					: "Saved."
			} Audit record ${result.audit}${
				result.transaction ? " · Transaction " + result.transaction : ""
			}`
		);
	}
	function dataset() {
		if (s.page === "overview") return "people";
		return s.page;
	}
	async function load() {
		if (s.page === "reports") {
			const kind = filterKind();
			const [result, dealers] = await Promise.all([
				api("report", { report: s.report, filters: s.filters, page: s.number }),
				["visits", "collections", "outstanding"].includes(kind)
					? api("visit_dealer_options", {
							account: s.filters.account || null,
							dataset: kind,
					  })
					: Promise.resolve([]),
			]);
			s.result = result;
			s.visitDealers = Array.isArray(dealers) ? dealers : [];
			s.metrics = s.result.totals || null;
		} else {
			const jobs = [
				api("list_records", { dataset: dataset(), filters: s.filters, page: s.number }),
			];
			if (s.page === "overview") jobs.push(api("overview", { filters: s.filters }));
			if (["visits", "collections"].includes(s.page))
				jobs.push(
					api("visit_dealer_options", {
						account: s.filters.account || null,
						dataset: s.page,
					})
				);
			const results = await Promise.all(jobs);
			s.result = results[0];
			s.metrics = s.page === "overview" ? results[1] || null : null;
			if (["visits", "collections"].includes(s.page))
				s.visitDealers = Array.isArray(results[1]) ? results[1] : [];
		}
		render();
	}
	function value(key, v) {
		if (v == null || v === "") return "—";
		if (key === "dealer_details")
			return `<div class="ledger-dealer"><strong>${esc(v.name || v.dealer_id)}</strong>${
				v.dealer_id && v.dealer_id !== v.name ? `<small>${esc(v.dealer_id)}</small>` : ""
			}${v.mobile_no ? `<small>Phone: ${esc(v.mobile_no)}</small>` : ""}</div>`;
		if (key === "collection_details")
			return `<div class="ledger-collection"><strong>${esc(
				v.payment_method || "Collection"
			)} · ${esc(money(v.amount))}</strong><small>${esc(
				date(v.collected_at)
			)}</small><small>Collection: ${esc(v.collection)}</small>${
				v.transaction_reference
					? `<small>Reference: ${esc(v.transaction_reference)}</small>`
					: ""
			}<small>${esc(v.status || "")}</small></div>`;
		if (key === "no_visit_duty") return Number(v) ? "Yes — benefits reversed" : "No";
		if (isDuration(key)) return esc(durationValue(key, v));
		if (key === "photo")
			return `<a href="${esc(
				v
			)}" target="_blank" rel="noopener"><img class="thumbnail" src="${esc(
				v
			)}" alt="Private shop evidence"></a>`;
		if (
			[
				"opening_balance",
				"closing_balance",
				"amount",
				"cash_impact",
				"outstanding_amount",
				"collections",
				"total_amount",
			].includes(key)
		)
			return esc(money(v));
		if (key === "smart_dsr_disabled") return Number(v) ? "Deactivated" : "Active";
		if (key === "duty_status")
			return (
				{
					Active: "Duty ON",
					Closed: "Duty OFF · Pending review",
					Finalized: "Duty OFF · Finalized",
				}[v] || esc(v)
			);
		if (key === "docstatus") return ["Draft", "Submitted", "Cancelled"][Number(v)] || esc(v);
		if (
			[
				"enabled",
				"smart_dsr_disabled",
				"paid_from_cash",
				"insurance_available",
				"puc_available",
				"rc_available",
				"fastag_available",
				"confirmed_insurance",
				"confirmed_puc",
				"confirmed_rc",
				"confirmed_fastag",
			].includes(key)
		)
			return Number(v) ? "Yes" : "No";
		if (isDateField(key))
			return esc(
				key.endsWith("_at") ||
					["creation", "modified", "posting_time"].includes(key) ||
					/\d[T ]\d{2}:\d{2}/.test(String(v))
					? date(v)
					: shortDate(v)
			);
		if (typeof v === "object")
			return `<span class="cell-text">${esc(JSON.stringify(v))}</span>`;
		return `<span class="cell-text">${esc(v)}</span>`;
	}
	function userProfileLink(user) {
		if (!(s.profile.can_edit_user_profiles ?? s.profile.can_manage_users)) return "";
		return `<a class="btn btn-default btn-sm user-profile-link" href="/app/user/${encodeURIComponent(
			user
		)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5-12 12-6 1 1-6Z M14 5l5 5"/></svg><span>Edit User Profile</span></a>`;
	}
	function ledgerDate(value) {
		if (!value) return "—";
		const stamp = new Date(String(value).replace(" ", "T"));
		if (Number.isNaN(stamp.getTime())) return esc(value);
		return `<time datetime="${esc(value)}"><span>${esc(shortDate(stamp))}</span><small>${esc(
			stamp.toLocaleTimeString("en-IN", {
				timeZone: "Asia/Kolkata",
				hour: "2-digit",
				minute: "2-digit",
				hour12: true,
			})
		)} IST</small></time>`;
	}
	function cashLedgerTable(rows, actions = true) {
		const movement = {
			Opening: "Opening Balance",
			"Cash Advance": "Opening Amount Added",
			"Cash Handover": "Cash Returned to Admin",
			"Dealer Cash Collection": "Dealer Collection",
			"Dealer Digital Collection": "Dealer Digital Collection",
			"Dealer Cheque Collection": "Dealer Cheque Collection",
		};
		return `<div class="table-scroll cash-ledger-scroll" role="region" aria-label="Cash ledger entries" tabindex="0"><table class="cash-ledger-table" aria-label="Cash ledger and adjustments"><colgroup><col style="width:12%"><col style="width:14%"><col style="width:11%"><col style="width:17%"><col style="width:22%"><col style="width:${
			actions ? 16 : 24
		}%">${
			actions ? '<col style="width:8%">' : ""
		}</colgroup><thead><tr><th>Date &amp; Time</th><th>Movement</th><th class="ledger-amount">Amount</th><th>Dealer</th><th>Collection Details</th><th>Remarks</th>${
			actions ? "<th>Details</th>" : ""
		}</tr></thead><tbody>${
			rows
				.map(
					(row) =>
						`<tr data-ledger-entry><td>${ledgerDate(
							row.posting_time
						)}</td><td><span class="ledger-movement">${esc(
							movement[row.transaction_type] || row.transaction_type
						)}</span></td><td class="ledger-amount ${
							Number(row.amount) < 0 ? "ledger-debit" : ""
						}">${esc(money(row.amount))}</td><td>${value(
							"dealer_details",
							row.dealer_details
						)}</td><td>${value(
							"collection_details",
							row.collection_details
						)}</td><td class="ledger-remarks"><span class="ledger-remarks-text" title="${esc(
							row.remarks || ""
						)}">${esc(row.remarks || "—")}</span></td>${
							actions
								? `<td>${btn(
										"View Details",
										"detail",
										`data-name="${esc(row.name)}" data-dataset="ledger"`
								  )}</td>`
								: ""
						}</tr>`
				)
				.join("") ||
			`<tr><td colspan="${
				actions ? 7 : 6
			}" class="empty">No cash ledger entries recorded.</td></tr>`
		}</tbody></table></div>`;
	}
	function dutyRecordsTable(rows) {
		const labels = { Active: "Duty ON", Closed: "Duty OFF", Finalized: "Finalized" };
		return `<div class="table-scroll duty-records-scroll" role="region" aria-label="Duty records" tabindex="0"><table class="duty-records-table"><colgroup><col style="width:12%"><col style="width:19%"><col style="width:10%"><col style="width:12%"><col style="width:21%"><col style="width:8%"><col style="width:11%"><col style="width:7%"></colgroup><thead><tr><th>Date / Duty</th><th>Salesperson</th><th>Status</th><th>Vehicle Number</th><th>Duty Time</th><th class="duty-numeric">GPS KM</th><th class="duty-numeric">Closing Balance</th><th>Details</th></tr></thead><tbody>${
			rows
				.map(
					(row) =>
						`<tr><td><div class="duty-cell"><strong>${esc(
							shortDate(row.work_date)
						)}</strong><small>${esc(
							row.name
						)}</small></div></td><td><div class="duty-cell"><strong>${esc(
							row.salesperson_name || row.account || "—"
						)}</strong>${
							row.salesperson_name && row.salesperson_name !== row.account
								? `<small>${esc(row.account)}</small>`
								: ""
						}</div></td><td><span class="duty-status" data-status="${esc(
							row.status
						)}">${esc(labels[row.status] || row.status || "—")}</span>${
							Number(row.no_visit_duty)
								? '<small class="duty-excluded">No visits · excluded</small>'
								: ""
						}</td><td>${esc(
							row.vehicle_number || "—"
						)}</td><td><div class="duty-cell"><span>Start: ${esc(
							date(row.started_at)
						)}</span><span>End: ${
							row.ended_at
								? esc(date(row.ended_at))
								: row.status === "Active"
								? "In progress"
								: "—"
						}</span><small>${
							row.duty_minutes == null
								? "—"
								: esc(durationValue("duty_minutes", row.duty_minutes))
						}</small></div></td><td class="duty-numeric">${
							row.verified_km == null
								? "—"
								: esc(
										Number(row.verified_km).toLocaleString("en-IN", {
											maximumFractionDigits: 2,
										})
								  )
						}</td><td class="duty-numeric">${esc(
							money(row.closing_balance)
						)}</td><td>${btn(
							"View",
							"detail",
							`data-name="${esc(
								row.name
							)}" data-dataset="duties" aria-label="View Details"`
						)}</td></tr>`
				)
				.join("") ||
			'<tr><td colspan="8" class="empty">No duty records match these filters.</td></tr>'
		}</tbody></table></div>`;
	}
	function table(rows, kind, actions = true) {
		if (kind === "ledger") return cashLedgerTable(rows, actions);
		if (kind === "duties" && s.page === "duties") return dutyRecordsTable(rows);
		const keys = columns[kind] || Object.keys(rows[0] || {}).slice(0, 12);
		return `<div class="table-scroll"><table><thead><tr>${keys
			.map((k) => `<th>${title(k)}</th>`)
			.join("")}${actions ? "<th>Details</th>" : ""}</tr></thead><tbody>${
			rows
				.map(
					(r) =>
						`<tr>${keys.map((k) => `<td>${value(k, r[k])}</td>`).join("")}${
							actions
								? `<td>${btn(
										"View Details",
										"detail",
										`data-name="${esc(r.name)}" data-dataset="${
											kind === "overview" ? "people" : kind
										}"`
								  )}</td>`
								: ""
						}</tr>`
				)
				.join("") ||
			`<tr><td colspan="${
				keys.length + 1
			}" class="empty">No records match these filters.</td></tr>`
		}</tbody></table></div>`;
	}
	function metricCards() {
		if (!s.metrics) return "";
		const keys = [
			"total_salespersons",
			"on_duty",
			"party_visits",
			"cash_collections",
			"expenses",
			"pending_review",
		];
		return `<div class="admin-metrics">${keys
			.map(
				(k) =>
					`<section><small>${title(k)}</small><strong>${
						[
							"cash_collections",
							"noncash_collections",
							"expenses",
							"outstanding_reviewed",
							"fuel_reimbursement",
							"meal_allowances",
							"other_expenses",
							"cash_expenses",
						].includes(k)
							? money(s.metrics[k])
							: s.metrics[k] ?? 0
					}</strong></section>`
			)
			.join("")}</div>`;
	}
	function filterKind() {
		return s.page === "reports"
			? {
					Salespersons: "people",
					"Opening Balances": "balances",
					Vehicles: "vehicles",
					"Duty Records": "duties",
					"Party Visits": "visits",
					"DSR Records": "dsrs",
					"Dealer Visits": "visits",
					Collections: "collections",
					"Outstanding Dues": "outstanding",
					Expenses: "expenses",
					"Cash Balances": "balances",
					"GPS Exceptions": "gps",
			  }[s.report] || "duties"
			: dataset();
	}
	function filterKey() {
		return `${s.page}:${s.page === "reports" ? s.report : ""}`;
	}
	function defaultFilters() {
		return s.page !== "overview" && ["people", "vehicles", "balances"].includes(filterKind())
			? { all_dates: true }
			: { from_date: s.profile.today, to_date: s.profile.today };
	}
	function rememberFilters() {
		s.sectionFilters[filterKey()] = { ...s.filters };
	}
	function restoreFilters() {
		s.filters = { ...(s.sectionFilters[filterKey()] || defaultFilters()) };
		s.number = 1;
	}
	function dealerPicker(selected = "") {
		const row = s.visitDealers.find((row) => row.name === selected);
		return `<label class="dealer-picker">Dealer<input type="hidden" name="customer" value="${esc(
			selected
		)}"><div class="dealer-input-wrap"><input type="text" data-dealer-search role="combobox" aria-label="Dealer" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="dealer-search-results" autocomplete="off" placeholder="Search dealer name…" value="${esc(
			row?.customer_name || selected
		)}"><button type="button" data-clear-dealer class="dealer-clear" aria-label="Clear dealer selection" ${
			selected ? "" : "hidden"
		}>×</button><span class="dealer-chevron" aria-hidden="true">⌄</span></div><div id="dealer-search-results" class="dealer-results" role="listbox" aria-label="Dealer options" hidden></div></label>`;
	}
	function bindDealerPicker(form) {
		const wrapper = form.querySelector(".dealer-picker"),
			field = wrapper.querySelector("[data-dealer-search]"),
			selected = form.elements.customer,
			list = wrapper.querySelector('[role="listbox"]'),
			clear = wrapper.querySelector("[data-clear-dealer]");
		let rows = [...s.visitDealers],
			visible = [],
			active = -1;
		if (selected.value && !rows.some((row) => row.name === selected.value))
			rows.push({ name: selected.value, customer_name: selected.value });
		const controller = new AbortController();
		const close = () => {
			list.hidden = true;
			field.setAttribute("aria-expanded", "false");
			field.removeAttribute("aria-activedescendant");
			active = -1;
		};
		const highlight = (index) => {
			active = index;
			list.querySelectorAll('[role="option"]').forEach((el, i) =>
				el.classList.toggle("is-highlighted", i === active)
			);
			const option = list.querySelectorAll('[role="option"]')[active];
			if (option) {
				field.setAttribute("aria-activedescendant", option.id);
				option.scrollIntoView({ block: "nearest" });
			}
		};
		const open = () => {
			if (field.disabled) return;
			const query = selected.value ? "" : field.value.trim().toLocaleLowerCase();
			visible = rows.filter((row) =>
				`${row.customer_name || row.name} ${row.name}`.toLocaleLowerCase().includes(query)
			);
			if (!query) visible.unshift({ name: "", customer_name: "All dealers" });
			list.innerHTML = visible.length
				? visible
						.map(
							(row, i) =>
								`<div id="dealer-option-${i}" class="dealer-option" role="option" aria-selected="${
									row.name === selected.value
								}" data-option-index="${i}"><strong>${esc(
									row.customer_name || row.name
								)}</strong>${
									row.name && row.name !== row.customer_name
										? `<small>${esc(row.name)}</small>`
										: ""
								}</div>`
						)
						.join("")
				: '<div class="dealer-no-results" role="status">No matching dealers found.</div>';
			list.style.maxHeight =
				Math.max(
					100,
					Math.min(280, innerHeight - field.getBoundingClientRect().bottom - 16)
				) + "px";
			list.hidden = false;
			active = -1;
			field.setAttribute("aria-expanded", "true");
			field.removeAttribute("aria-activedescendant");
		};
		const choose = (index) => {
			const row = visible[index];
			if (!row) return;
			selected.value = row.name;
			field.value = row.name ? row.customer_name || row.name : "";
			field.setCustomValidity("");
			clear.hidden = !row.name;
			close();
			field.focus();
			close();
		};
		field.onfocus = open;
		field.onblur = close;
		field.onclick = () => {
			if (list.hidden) open();
		};
		field.oninput = () => {
			selected.value = "";
			clear.hidden = !field.value;
			field.setCustomValidity(field.value.trim() ? "Select a dealer from the list." : "");
			open();
		};
		field.onkeydown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
			} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (list.hidden) open();
				if (visible.length)
					highlight(
						active < 0
							? event.key === "ArrowDown"
								? 0
								: visible.length - 1
							: event.key === "ArrowDown"
							? (active + 1) % visible.length
							: (active - 1 + visible.length) % visible.length
					);
			} else if (event.key === "Enter" && !list.hidden && visible.length) {
				event.preventDefault();
				choose(active >= 0 ? active : 0);
			} else if (event.key === "Tab") close();
		};
		list.onpointerdown = (event) => event.preventDefault();
		list.onclick = (event) => {
			event.preventDefault();
			const option = event.target.closest("[data-option-index]");
			if (option) choose(Number(option.dataset.optionIndex));
		};
		clear.onclick = () => {
			selected.value = "";
			field.value = "";
			field.setCustomValidity("");
			clear.hidden = true;
			field.focus();
			open();
		};
		document.addEventListener(
			"pointerdown",
			(event) => {
				if (!wrapper.contains(event.target)) close();
			},
			{ signal: controller.signal }
		);
		return {
			destroy: () => controller.abort(),
			setDisabled: (disabled) => {
				field.disabled = disabled;
				selected.disabled = disabled;
				clear.disabled = disabled;
				if (disabled) close();
			},
			setOptions: (options) => {
				rows = options;
				const row = rows.find((row) => row.name === selected.value);
				selected.value = row?.name || "";
				field.value = row ? row.customer_name || row.name : "";
				field.setCustomValidity("");
				clear.hidden = !selected.value;
				close();
			},
		};
	}
	function filterControls() {
		return (
			(s.page === "reports"
				? `<div class="report-selector">${select(
						"Report",
						"report",
						reports,
						s.report
				  )}<p class="hint">Choose a section, then apply its filters. Export includes all matching records.</p></div>`
				: "") + sectionFilterControls()
		);
	}
	function sectionFilterControls() {
		const kind = filterKind(),
			f = s.filters;
		const period =
			s.page === "reports" && ["Daily", "Weekly", "Monthly", "Quarterly"].includes(s.report);
		const searches = {
			people: "Salesperson name or email",
			balances: "Salesperson name or email",
			vehicles: "Vehicle number only",
			duties: "Duty ID, user or vehicle number",
			visits: "Visit ID, dealer or user",
			collections: "Dealer, receipt or transaction reference",
			expenses: "Expense ID, category or remarks",
			dsrs: "DSR ID, owner or salesperson",
			audit: "Actor, record, action or reason",
			outstanding: "Invoice ID or dealer",
			gps: "Event ID, user or details",
		};
		const options = {
			duties: ["Active", "Closed", "Finalized"],
			visits: ["Open", "Completed", "Deleted"],
			collections: ["Recorded", "Posted", "Reversed"],
			expenses: ["Recorded", "Reversed"],
			vehicles: ["Active", "Inactive"],
			dsrs: [
				["0", "Draft"],
				["1", "Submitted"],
				["2", "Cancelled"],
			],
		};
		const choice = (label, key, values) =>
			select(label, key, [["", `All ${label.toLowerCase()}`], ...values], f[key] ?? "");
		const rowsWithDates = (primary) =>
			`${primary}${input("From Date", "from_date", f.from_date || "", 'type="date"')}${input(
				"To Date",
				"to_date",
				f.to_date || "",
				'type="date"'
			)}<label class="dsr-checkbox-option"><input type="checkbox" name="all_dates" ${
				f.all_dates ? "checked" : ""
			}><span>All dates</span></label><div class="filter-actions"><button type="submit" class="primary">Apply Filters</button>${btn(
				"Clear Filters",
				"clear-filters"
			)}</div>`;
		if (kind === "collections" && !period)
			return rowsWithDates(
				`${input(
					"Search",
					"search",
					f.search || "",
					'type="search" placeholder="Collection ID, dealer or reference"'
				)}${input(
					"Salesperson",
					"account",
					f.account || "",
					'list="dsr-users"'
				)}${dealerPicker(f.customer || "")}${select(
					"Payment Method",
					"payment_method",
					[["", "All payment methods"], "Cash", "UPI", "Bank Transfer", "Cheque"],
					f.payment_method || ""
				)}`
			);
		if (kind === "expenses" && !period)
			return rowsWithDates(
				`${input(
					"Search",
					"search",
					f.search || "",
					'type="search" placeholder="Expense ID, category or remarks"'
				)}${input("Salesperson", "account", f.account || "", 'list="dsr-users"')}${select(
					"Status",
					"status",
					[["", "All statuses"], ...options.expenses],
					f.status || ""
				)}${select(
					"Category",
					"category",
					[
						["", "All categories"],
						"Fuel (CNG/Petrol/Diesel)",
						"Other Expense",
						"Fuel Reimbursement",
						"Toll",
						"Parking",
						"Accommodation",
						"Other Business Expenses",
						"Breakfast",
						"Lunch",
						"Dinner",
						"Night Stay",
					],
					f.category || ""
				)}`
			);
		if (kind === "visits" && !period)
			return `${input(
				"Search",
				"search",
				f.search || "",
				'type="search" placeholder="Visit ID, dealer or salesperson email"'
			)}${input(
				"Salesperson",
				"account",
				f.account || "",
				'list="dsr-users"'
			)}${dealerPicker(f.customer || "")}${select(
				"Status",
				"status",
				[["", "All statuses"], ...options.visits],
				f.status || ""
			)}${input("From Date", "from_date", f.from_date || "", 'type="date"')}${input(
				"To Date",
				"to_date",
				f.to_date || "",
				'type="date"'
			)}<label class="dsr-checkbox-option"><input type="checkbox" name="all_dates" ${
				f.all_dates ? "checked" : ""
			}><span>All dates</span></label><div class="filter-actions"><button type="submit" class="primary">Apply Filters</button>${btn(
				"Clear Filters",
				"clear-filters"
			)}</div>`;
		if (kind === "dsrs" && !period)
			return `${input(
				"Search",
				"search",
				f.search || "",
				'type="search" placeholder="Search DSR records"'
			)}${input("Salesperson", "account", f.account || "", 'list="dsr-users"')}${select(
				"Status",
				"status",
				[["", "All statuses"], ...options.dsrs],
				f.status || ""
			)}<label class="dsr-checkbox-option"><input type="checkbox" name="all_dates" ${
				f.all_dates ? "checked" : ""
			}><span>All dates</span></label>${input(
				"From Date",
				"from_date",
				f.from_date || "",
				'type="date"'
			)}${input(
				"To Date",
				"to_date",
				f.to_date || "",
				'type="date"'
			)}<div class="filter-actions"><button type="submit" class="primary">Apply Filters</button>${btn(
				"Clear Filters",
				"clear-filters"
			)}</div>`;
		if (kind === "duties" && !period)
			return `${input(
				"Search Duty Records",
				"search",
				f.search || "",
				'type="search" placeholder="Duty ID, email or vehicle number"'
			)}${input("Salesperson", "account", f.account || "", 'list="dsr-users"')}${select(
				"Status",
				"status",
				[["", "All statuses"], ...options.duties],
				f.status || ""
			)}${input("From Date", "from_date", f.from_date || "", 'type="date"')}${input(
				"To Date",
				"to_date",
				f.to_date || "",
				'type="date"'
			)}<label class="dsr-checkbox-option"><input type="checkbox" name="all_dates" ${
				f.all_dates ? "checked" : ""
			}><span>All dates</span></label><div class="filter-actions"><button type="submit" class="primary">Apply Filters</button>${btn(
				"Clear Filters",
				"clear-filters"
			)}</div>`;

		let html = "";
		html += input(
			"Search",
			"search",
			f.search || "",
			`type="search" placeholder="${searches[kind] || "Search records"}"`
		);
		html += input(
			kind === "vehicles" ? "Allocated Salesperson" : "Salesperson",
			"account",
			f.account || "",
			'list="dsr-users" placeholder="All salespersons"'
		);
		if (kind === "balances")
			html += input("Balance as of", "balance_as_of", f.balance_as_of || "", 'type="date"');
		else if (!["people", "vehicles"].includes(kind) || s.page === "overview") {
			html += period
				? input("Period ending", "to_date", f.to_date || s.profile.today, 'type="date"')
				: input("From Date", "from_date", f.from_date || "", 'type="date"') +
				  input("To Date", "to_date", f.to_date || "", 'type="date"');
			if (!period)
				html += `<label class="dsr-checkbox-option"><input type="checkbox" name="all_dates" ${
					f.all_dates ? "checked" : ""
				}><span>All dates</span></label>`;
		}
		if (["visits", "collections", "expenses"].includes(kind))
			html += input("Duty Session", "duty", f.duty || "", 'placeholder="Duty ID"');
		if (["visits", "collections", "outstanding"].includes(kind))
			html += dealerPicker(f.customer || "");
		if (kind === "visits")
			html += input(
				"Visit Number",
				"visit_number",
				f.visit_number || "",
				'type="number" min="1"'
			);
		if (options[kind]) html += choice("Status", "status", options[kind]);
		if (kind === "people" && s.page !== "overview")
			html += choice("DSR Access", "smart_dsr_disabled", [
				["0", "Active"],
				["1", "Deactivated"],
			]);
		if (kind === "collections")
			html += choice("Payment Method", "payment_method", [
				"Cash",
				"UPI",
				"Bank Transfer",
				"Cheque",
			]);
		if (kind === "expenses")
			html += choice("Category", "category", [
				"Fuel Reimbursement",
				"Toll",
				"Parking",
				"Accommodation",
				"Other Business Expenses",
				"Breakfast",
				"Lunch",
				"Dinner",
				"Night Stay",
			]);
		if (kind === "vehicles")
			html += choice("Fuel Type", "fuel_type", ["Petrol", "Diesel", "CNG"]);
		if (kind === "audit")
			html += input(
				"Record Type",
				"record_type",
				f.record_type || "",
				'placeholder="Document type"'
			);
		return (
			html +
			`<div class="filter-actions"><button type="submit" class="primary">Apply Filters</button>${btn(
				"Clear Filters",
				"clear-filters"
			)}</div>`
		);
	}
	function render() {
		s.dealerCleanup?.();
		s.dealerCleanup = null;
		root.querySelector("#admin-save-confirm")?.close();
		root.querySelector("#admin-dialog")?.routeCleanup?.();
		const pageLabel = nav.find((x) => x[0] === s.page)?.[1] || "Overview";
		const kind = s.page === "reports" ? s.result.dataset : dataset();
		const filterLayout =
			{
				dsrs: "dsr-record-filters",
				duties: "duty-record-filters",
				visits: "party-visit-filters",
				collections: "record-filter-rows",
				expenses: "record-filter-rows",
			}[filterKind()] || "";
		root.innerHTML = `<aside class="admin-sidebar"><a href="/app/smart-dsr/admin" target="_top" class="admin-brand"><b>SRV</b><span>SRV Electricals<small>Smart DSR Control Panel</small></span></a><nav>${nav
			.map(
				([id, label]) =>
					`<a class="${s.page === id ? "active" : ""}" href="#${id}">${label}</a>`
			)
			.join(
				""
			)}</nav><a class="back-link" href="/app/home" target="_top">← Back to Home</a></aside><div class="admin-content"><header><div><p class="eyebrow">ADMINISTRATOR</p><h1>${pageLabel}</h1></div><span>${esc(
			s.profile.user
		)}</span></header><div id="admin-message" role="status" hidden></div><section class="panel">${
			s.page === "duties"
				? '<div class="section-title"><h2>Filter Duty Records</h2></div>'
				: ""
		}<form id="admin-filters" class="filters ${filterLayout}">${filterControls()}</form></section>${
			s.page === "reports"
				? `<section class="panel report-tools"><span class="hint">${esc(s.report)} · ${
						s.result.total
				  } matching records · Export all matches</span>${btn("Excel", "xlsx")}${btn(
						"PDF",
						"pdf"
				  )}</section>`
				: ""
		}${metricCards()}<section class="panel"><div class="section-title"><div><h2>${
			s.page === "reports" ? esc(s.report) + " Report" : pageLabel
		}</h2><small>${
			s.result.total
		} matching records · Search and filters apply to this section</small></div><div class="toolbar">${
			s.page === "people" && (s.profile.can_create_users ?? s.profile.can_manage_users)
				? '<a class="btn btn-primary btn-sm user-profile-link" href="/app/user/new-user-1"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>Add Salesperson</span></a>'
				: ""
		}${
			s.page === "balances" && s.profile.can_finance
				? btn("Add Opening Amount", "opening-add") +
				  btn("Record Returned Cash", "opening-return")
				: ""
		}${s.page === "vehicles" ? btn("Add Vehicle", "add-vehicle") : ""}</div></div>${
			s.page === "people" && (s.profile.can_create_users ?? s.profile.can_manage_users)
				? '<p class="hint">For a new salesperson, choose the Sales Role Profile on the User form.</p>'
				: ""
		}${
			s.page === "balances"
				? '<p class="hint">Opening includes cash added by admin. Returned cash reduces both opening and closing balances. Changes after a finalized DSR carry into the next opening; finalized records stay unchanged.</p>'
				: ""
		}${
			s.page === "expenses"
				? '<p class="hint">Expense records include verified-distance fuel and meal entitlements. Expenses do not reduce DSR closing balances.</p>'
				: ""
		}${table(
			s.result.rows,
			s.page === "overview" ? "overview" : kind,
			s.page !== "reports"
		)}<div class="pagination">${btn(
			"Previous",
			"previous",
			s.number <= 1 ? "disabled" : ""
		)}<span>Page ${s.number} · ${s.result.total} records</span>${btn(
			"Next",
			"next",
			s.number * (s.result.page_size || 20) >= s.result.total ? "disabled" : ""
		)}</div></section><footer>Financial changes preserve original transactions and audit history.</footer></div><dialog id="admin-dialog"></dialog>`;
		bind();
	}
	function modal(title, body) {
		const d = root.querySelector("#admin-dialog");
		d.routeCleanup?.();
		d.innerHTML = `<div class="section-title"><h2>${esc(
			title
		)}</h2><button type="button" data-close aria-label="Close">×</button></div><div id="dialog-error" role="alert" hidden></div>${body}`;
		bindDateInputs(d);
		d.classList.toggle("ledger-details-dialog", !!d.querySelector("[data-ledger-entry]"));
		d.querySelector("[data-close]").onclick = () => d.close();
		d.showModal();
		return d;
	}
	function renderDetail(data, depth = 0) {
		if (data == null || data === "") return '<span class="hint">—</span>';
		if (typeof data === "string" && /^[\[{]/.test(data) && depth < 3) {
			try {
				return renderDetail(JSON.parse(data), depth + 1);
			} catch (_) {
				// Keep the fallback when optional cached data or error details are unavailable.
			}
		}
		if (Array.isArray(data)) {
			if (!data.length) return '<p class="hint">No records.</p>';
			if (data.every((item) => typeof item !== "object")) return esc(data.join(", "));
			const keys = [...new Set(data.flatMap((item) => Object.keys(item || {})))]
				.filter(
					(key) =>
						![
							"doctype",
							"idx",
							"parent",
							"parenttype",
							"parentfield",
							"territory",
							"territories",
						].includes(key)
				)
				.slice(0, 15);
			return `<div class="table-scroll"><table><thead><tr>${keys
				.map((key) => `<th>${title(key)}</th>`)
				.join("")}</tr></thead><tbody>${data
				.map(
					(row) =>
						`<tr>${keys
							.map(
								(key) =>
									`<td>${
										key.endsWith("_available") ||
										isDuration(key) ||
										isDateField(key) ||
										key === "no_visit_duty"
											? value(key, row?.[key])
											: depth < 3
											? renderDetail(row?.[key], depth + 1)
											: esc(row?.[key])
									}</td>`
							)
							.join("")}</tr>`
				)
				.join("")}</tbody></table></div>`;
		}
		if (typeof data === "object")
			return `<dl class="detail-grid">${Object.entries(data)
				.filter(
					([key]) =>
						![
							"doctype",
							"idx",
							"parent",
							"parenttype",
							"parentfield",
							"territory",
							"territories",
							"__onload",
							"_user_tags",
							"_comments",
							"_assign",
							"_liked_by",
						].includes(key)
				)
				.map(
					([key, val]) =>
						`<div><dt>${title(key)}</dt><dd>${
							key.endsWith("_available") ||
							isDuration(key) ||
							isDateField(key) ||
							key === "no_visit_duty"
								? value(key, val)
								: depth < 3
								? renderDetail(val, depth + 1)
								: esc(val)
						}</dd></div>`
				)
				.join("")}</dl>`;
		return esc(data);
	}
	function jsonBlock(label, data) {
		return `<details open><summary>${esc(label)}</summary>${renderDetail(data)}</details>`;
	}

	function linkedDetail(label, data, kind) {
		const rows = Array.isArray(data) ? data : data?.rows;
		if (!kind || !Array.isArray(rows)) return jsonBlock(label, data);
		return `<details open><summary>${esc(label)}</summary>${
			kind === "ledger"
				? `<p class="hint ledger-entry-count">${rows.length} ${
						rows.length === 1 ? "entry" : "entries"
				  }${data?.total > rows.length ? ` shown of ${data.total}` : ""}</p>`
				: ""
		}${table(rows, kind)}</details>`;
	}
	function bindLinkedDetails(dialog) {
		dialog.querySelectorAll('[data-action="detail"]').forEach((button) => {
			button.onclick = () => run(() => view(button.dataset.dataset, button.dataset.name));
		});
	}
	async function perform(method, values, reasonText, requestKey) {
		const result = await api(method, {
			...values,
			reason_text: reasonText,
			request_key: requestKey,
		});
		root.querySelector("dialog")?.close();
		await load();
		success(result);
	}
	function allocationRow(row = {}) {
		return `<div class="allocation-row"><label>Invoice<input data-invoice value="${esc(
			row.invoice || ""
		)}" placeholder="Sales Invoice ID"></label><label>Amount<input data-allocated type="number" step="0.01" min="0" value="${esc(
			row.amount || ""
		)}"></label><button type="button" data-remove-allocation>Remove</button></div>`;
	}
	function allocationFields(rows) {
		return `<fieldset><legend>Invoice Allocations</legend><div id="admin-allocations">${rows
			.map(allocationRow)
			.join(
				""
			)}</div><button type="button" data-add-allocation>Add Invoice Allocation</button></fieldset>`;
	}
	function readAllocations() {
		return [...root.querySelectorAll(".allocation-row")]
			.filter(
				(row) =>
					row.querySelector("[data-invoice]").value ||
					row.querySelector("[data-allocated]").value
			)
			.map((row) => ({
				invoice: row.querySelector("[data-invoice]").value.trim(),
				amount: row.querySelector("[data-allocated]").value,
			}));
	}
	function formSnapshot(form) {
		const fields = new Map();
		for (const el of form.querySelectorAll("input[name], select[name], textarea[name]")) {
			if ((el.type === "hidden" && !el.hasAttribute("data-date-value")) || el.disabled)
				continue;
			const label = el.labels?.[0]?.cloneNode(true);
			label?.querySelectorAll("input, select, textarea").forEach((node) => node.remove());
			const raw = el.type === "checkbox" ? String(el.checked) : el.value;
			const display = el.hasAttribute("data-date-value")
				? el.value
					? shortDate(el.value)
					: ""
				: el.type === "file"
				? [...el.files].map((file) => file.name).join(", ")
				: el.type === "checkbox"
				? el.checked
					? "Yes"
					: "No"
				: el.tagName === "SELECT"
				? el.selectedOptions[0]?.textContent || el.value
				: el.value;
			const task = el.closest("[data-pending-task]")?.querySelector("legend")?.textContent;
			const fieldLabel =
				el.getAttribute("aria-label") || label?.textContent.trim() || title(el.name);
			fields.set(el.name, {
				raw,
				display,
				label: task ? `${task} — ${fieldLabel}` : fieldLabel,
			});
		}
		if (form.querySelector("#admin-allocations"))
			fields.set("allocations", {
				raw: JSON.stringify(readAllocations()),
				display: readAllocations()
					.map((row) => `${row.invoice}: ${row.amount}`)
					.join("; "),
				label: "Invoice Allocations",
			});
		return fields;
	}
	function confirmSave(action, record, changes, method) {
		return new Promise((resolve) => {
			const dialog = document.createElement("dialog");
			dialog.id = "admin-save-confirm";
			dialog.setAttribute("aria-labelledby", "save-confirm-title");
			const effect =
				method === "replace_financial"
					? "The original transaction will be reversed and a replacement created."
					: method === "request_field_correction"
					? "A correction request will be recorded. The original record will remain unchanged."
					: method === "record_opening_movement"
					? "A cash ledger entry will record this addition or return. The balances shown above are the expected result. Finalized DSR records will stay unchanged."
					: method === "manage_user"
					? "Only this salesperson’s Smart DSR access will change. User roles and profile details will stay unchanged."
					: method === "change_duty_status"
					? "The duty status will change after the server checks pending work and required evidence."
					: method === "correct_metadata"
					? "Eligible fields will be updated. Submitted visits and finalized DSRs create a correction request instead of changing the original."
					: "The server will validate and save this action.";
			dialog.innerHTML = `<h2 id="save-confirm-title">Confirm ${esc(action)}</h2>${
				record
					? `<p class="save-confirm-record">Record: <strong>${esc(record)}</strong></p>`
					: ""
			}<p>Review what will change before continuing.</p>${
				changes.length
					? `<div class="table-scroll"><table><thead><tr><th>Field</th><th>Current Value</th><th>New Value</th></tr></thead><tbody>${changes
							.map(
								(row) =>
									`<tr><th scope="row">${esc(row.label)}</th><td>${esc(
										row.before || "Not set"
									)}</td><td>${esc(row.after || "Not set")}</td></tr>`
							)
							.join("")}</tbody></table></div>`
					: `<p class="hint">No form fields have changed. You are confirming the ${esc(
							action.toLowerCase()
					  )} action.</p>`
			}<p class="hint">${esc(
				effect
			)}</p><div class="save-confirm-actions"><button type="button" data-cancel-save autofocus>Cancel</button><button type="button" class="primary" data-confirm-save>Confirm Save</button></div>`;
			let accepted = false;
			dialog.querySelector("[data-cancel-save]").onclick = () => dialog.close();
			dialog.querySelector("[data-confirm-save]").onclick = () => {
				accepted = true;
				dialog.close();
			};
			dialog.addEventListener(
				"close",
				() => {
					dialog.remove();
					resolve(accepted);
				},
				{ once: true }
			);
			root.append(dialog);
			dialog.showModal();
		});
	}
	function formDialog(
		title,
		body,
		method,
		fixed = {},
		transform = (x) => x,
		standardSave = true
	) {
		const key = crypto.randomUUID();
		const d = modal(
			title,
			`<form>${body}<button class="primary">${
				standardSave ? "Save" : "Save Vehicle"
			}</button></form>`
		);
		const allocations = d.querySelector("#admin-allocations");
		if (allocations) {
			d.querySelector("[data-add-allocation]").onclick = () =>
				allocations.insertAdjacentHTML("beforeend", allocationRow());
			allocations.onclick = (event) => {
				if (event.target.closest("[data-remove-allocation]"))
					event.target.closest(".allocation-row").remove();
			};
		}
		const form = d.querySelector("form");
		const original = formSnapshot(form);
		form.onsubmit = async (e) => {
			e.preventDefault();
			if (d.dataset.saving) return;
			d.dataset.saving = "1";
			const submit = e.target.querySelector("button.primary");
			submit.disabled = true;
			const values = Object.fromEntries(new FormData(e.target));
			const enteredReason =
				typeof values.reason_text === "string" ? values.reason_text.trim() : "";
			delete values.reason_text;
			const current = formSnapshot(form);
			const creating =
				method === "opening_balance" || (method === "manage_vehicle" && !fixed.name);
			const changes = [...current]
				.filter(([name, item]) => creating || item.raw !== original.get(name)?.raw)
				.map(([name, item]) => ({
					label: item.label,
					before: creating ? "" : original.get(name)?.display || "",
					after: item.display,
				}));
			if (form.reviewChanges) changes.splice(0, changes.length, ...form.reviewChanges());
			if (method === "request_field_correction") {
				changes.splice(0, changes.length, {
					label: current.get("field")?.display || values.field,
					before: d.querySelector("[data-current-value]").value,
					after: values.value,
				});
			}
			const record =
				fixed.name ||
				fixed.duty ||
				fixed.user ||
				values.duty ||
				values.user ||
				values.registration_number ||
				"";
			const confirmed = await confirmSave(title, record, changes, method);
			if (!confirmed) {
				delete d.dataset.saving;
				submit.disabled = false;
				submit.focus();
				return;
			}
			const reasonText =
				enteredReason ||
				(
					`${title} confirmed. ` +
					changes
						.map(
							(row) =>
								`${row.label}: ${row.before || "Not set"} → ${
									row.after || "Not set"
								}`
						)
						.join("; ")
				).slice(0, 2000);
			Promise.resolve()
				.then(() => transform(values))
				.then((transformed) =>
					perform(method, { ...fixed, ...transformed }, reasonText, key)
				)
				.catch((error) => {
					const box = d.querySelector("#dialog-error");
					box.hidden = false;
					box.textContent = error.message;
				})
				.finally(() => {
					delete d.dataset.saving;
					submit.disabled = false;
				});
		};
		return d;
	}
	async function openingMovement(action, user = "") {
		let snapshot = null;
		const adding = action === "add";
		const d = formDialog(
			adding ? "Add Opening Amount" : "Record Returned Cash",
			`${input("Salesperson", "user", user, 'required list="dsr-users"')}${input(
				adding ? "Amount to Add" : "Amount Returned to Admin",
				"value",
				"",
				'type="number" min="0.01" step="0.01" required'
			)}<label>Reason<textarea name="reason_text" required maxlength="2000" placeholder="Explain this cash addition or return"></textarea></label><div data-balance-preview role="status"></div>`,
			"record_opening_movement",
			{ action },
			(values) => ({
				user: values.user,
				value: values.value,
				expected_balance: snapshot?.current_cash ?? 0,
				expected_opening: snapshot?.opening_balance ?? 0,
			})
		);
		const form = d.querySelector("form"),
			person = form.elements.user,
			amount = form.elements.value,
			preview = d.querySelector("[data-balance-preview]"),
			save = form.querySelector("button.primary");
		const projected = () => {
			const number = Number(amount.value || 0);
			return {
				opening: Number(snapshot?.opening_balance || 0) + (adding ? number : -number),
				closing: Number(snapshot?.current_cash || 0) + (adding ? number : -number),
			};
		};
		form.reviewChanges = () => {
			const after = projected();
			return [
				{
					label: adding ? "Opening Amount Added" : "Cash Returned to Admin",
					before: "",
					after: money(amount.value),
				},
				{
					label: "Opening Balance",
					before: money(snapshot?.opening_balance),
					after: money(after.opening),
				},
				{
					label: "Closing Balance",
					before: money(snapshot?.current_cash),
					after: money(after.closing),
				},
				{ label: "Reason", before: "", after: form.elements.reason_text.value.trim() },
			];
		};
		const update = () => {
			amount.setCustomValidity("");
			if (!snapshot) return;
			const limit = adding ? 1000000 : Math.max(0, Number(snapshot.current_cash || 0));
			const exceeds = Number(amount.value) > limit;
			amount.max = String(limit);
			if (exceeds)
				amount.setCustomValidity(
					adding
						? "Amount to Add cannot exceed ₹10,00,000 per entry."
						: `Returned cash cannot exceed the closing balance of ${money(limit)}.`
				);
			const after = projected();
			preview.innerHTML = `<div class="balance-movement-preview"><p>Current Opening: <strong>${esc(
				money(snapshot.opening_balance)
			)}</strong></p><p>Current Closing: <strong>${esc(
				money(snapshot.current_cash)
			)}</strong></p><p>Opening After Save: <strong>${esc(
				money(after.opening)
			)}</strong></p><p>Closing After Save: <strong>${
				exceeds ? "Invalid amount" : esc(money(after.closing))
			}</strong></p></div>${
				!adding
					? `<p class="hint" ${exceeds ? 'role="alert"' : ""}>${
							exceeds ? "Returned cash is too high. " : ""
					  }Maximum return: <strong>${esc(money(limit))}</strong>.</p>`
					: ""
			}<p class="hint">${
				adding
					? "Maximum addition: ₹10,00,000 per entry. Added cash increases opening and closing balances."
					: "Only record cash actually received back by admin. Both opening and closing balances are reduced."
			}</p>`;
		};
		let lookup = 0;
		const loadBalance = async () => {
			const marker = ++lookup;
			snapshot = null;
			save.disabled = true;
			if (!person.value) {
				preview.textContent = "Select a salesperson to see the balance.";
				return;
			}
			preview.textContent = "Loading current balance…";
			try {
				const result = await api("balance_details", { user: person.value });
				if (marker !== lookup || !d.isConnected) return;
				snapshot = result;
				if (!adding && snapshot.current_cash == null) {
					preview.textContent =
						"This salesperson has no opening balance to return. Add an opening amount first.";
					return;
				}
				update();
				save.disabled = !adding && Number(snapshot.current_cash) <= 0;
			} catch (error) {
				if (marker === lookup) preview.textContent = error.message;
			}
		};
		form.elements.reason_text.oninput = () =>
			form.elements.reason_text.setCustomValidity(
				form.elements.reason_text.value.trim() ? "" : "Enter a reason before saving."
			);
		person.onchange = loadBalance;
		amount.oninput = update;
		await loadBalance();
	}
	function vehicleFields(r = {}) {
		const users = [...s.profile.users];
		if (r.allocated_to && !users.some((user) => user.name === r.allocated_to))
			users.unshift({
				name: r.allocated_to,
				full_name: r.allocated_to_name || r.allocated_to,
			});
		return (
			`<label>Allocated Salesperson<select name="allocated_to" required><option value="">Select salesperson</option>${users
				.map(
					(user) =>
						`<option value="${esc(user.name)}" ${
							r.allocated_to === user.name ? "selected" : ""
						}>${esc(user.full_name || user.name)} (${esc(user.name)})</option>`
				)
				.join("")}</select></label>` +
			input(
				"Vehicle Number",
				"registration_number",
				r.registration_number || "",
				"required"
			) +
			select(
				"Fuel Type",
				"fuel_type",
				["Petrol", "Diesel", "CNG"],
				r.fuel_type || "Petrol"
			) +
			[
				["insurance", "Insurance"],
				["puc", "PUC"],
				["rc", "RC"],
				["fastag", "FASTag"],
			]
				.map(
					([key, label]) =>
						`<input type="hidden" name="${key}_available" value="0"><label class="dsr-checkbox-option"><input type="checkbox" name="${key}_available" value="1" ${
							!r.name ? "required" : ""
						} ${
							Number(r[key + "_available"]) ? "checked" : ""
						}><span>${label} Available</span></label>`
				)
				.join("") +
			input(
				"Insurance Expiry (optional)",
				"insurance_expiry",
				r.insurance_expiry || "",
				'type="date"'
			) +
			input("PUC Expiry (optional)", "puc_expiry", r.puc_expiry || "", 'type="date"') +
			input("RC Expiry (optional)", "rc_expiry", r.rc_expiry || "", 'type="date"') +
			select("Status", "status", ["Active", "Inactive"], r.status || "Active")
		);
	}
	function manageVehicle(r = {}) {
		formDialog(
			r.name ? "Edit Vehicle" : "Add Vehicle",
			vehicleFields(r),
			"manage_vehicle",
			r.name ? { name: r.name } : {},
			(values) => ({ values }),
			false
		);
	}
	function editDsrAccess(profile) {
		formDialog(
			"Edit Smart DSR Access",
			`<p>Salesperson: <strong>${esc(
				profile.employee_name || profile.account || profile.name
			)}</strong></p>${select(
				"Smart DSR Access",
				"access_enabled",
				[
					["1", "Active"],
					["0", "Deactivated"],
				],
				Number(profile.smart_dsr_disabled) ? "0" : "1"
			)}`,
			"manage_user",
			{ user: profile.account || profile.name }
		);
	}
	async function view(kind, name) {
		const data = await api("details", { dataset: kind, name });
		if (kind === "vehicles") {
			const r = data.record;
			const vehicleDetails = { ...r, added_by: r.added_by_name || r.added_by };
			delete vehicleDetails.added_by_name;
			delete vehicleDetails.added_by_salesperson;
			for (const field of [
				"vehicle_type",
				"make",
				"model",
				"insurance_number",
				"puc_number",
				"rc_number",
				"fastag_details",
			])
				delete vehicleDetails[field];
			const d = modal(
				"Vehicle · " + r.registration_number,
				`<div class="detail-actions">${btn(
					"Edit Vehicle",
					"edit-vehicle"
				)}</div>${jsonBlock("Vehicle details", vehicleDetails)}`
			);
			d.querySelector('[data-action="edit-vehicle"]').onclick = () => manageVehicle(r);
			return;
		}
		if (kind === "balances" || kind === "people") {
			const p = data.profile;
			const editable = kind === "people" && s.page === "people";
			const controls = editable
				? `${
						userProfileLink(p.account || p.name || name)
							? `<div class="salesperson-profile-action"><div><h3>User Profile</h3><p>Edit contact details and user settings in ERPNext.</p></div>${userProfileLink(
									p.account || p.name || name
							  )}</div>`
							: ""
				  }<div class="detail-actions">${
						s.profile.can_manage_users
							? btn("Edit Smart DSR Access", "edit-dsr-access")
							: ""
				  }</div>`
				: kind === "balances" && s.page === "balances" && s.profile.can_finance
				? `<div class="detail-actions">${btn("Add Opening Amount", "opening-add")}${btn(
						"Record Returned Cash",
						"opening-return"
				  )}</div>`
				: "";
			const d = modal(
				"Salesperson · " + (p.employee_name || name),
				`${controls}${jsonBlock("Salesperson Profile", p)}${jsonBlock(
					"Cash / previous finalized closing",
					{
						initial_opening: data.initial_opening,
						current_cash: data.current_cash,
						previous_finalized: data.previous_finalized,
					}
				)}${linkedDetail("Duty history", data.duties, "duties")}${linkedDetail(
					"DSR history",
					data.dsrs,
					"dsrs"
				)}${linkedDetail("Cash ledger and adjustments", data.ledger, "ledger")}`
			);
			bindLinkedDetails(d);
			d.querySelector('[data-action="opening-add"]')?.addEventListener("click", () =>
				run(() => openingMovement("add", name))
			);
			d.querySelector('[data-action="opening-return"]')?.addEventListener("click", () =>
				run(() => openingMovement("return", name))
			);
			d.querySelector('[data-action="edit-dsr-access"]')?.addEventListener("click", () =>
				editDsrAccess(p)
			);
			return;
		}
		const r = data.record;
		const dataset = r.doctype === "DSR Duty Session" ? "duties" : kind;
		const d = modal(
			title(kind) + " · " + name,
			`${dataset === "duties" && window.SmartDSRRoute ? window.SmartDSRRoute.markup() : ""}${
				data.photos
					? `<div class="photo-grid">${data.photos
							.map(
								(p) =>
									`<figure><a href="${esc(
										p.photo
									)}" target="_blank" rel="noopener"><img src="${esc(
										p.photo
									)}" alt="Original private shop evidence"></a><figcaption>${date(
										p.captured_at
									)} · ${esc(p.capture_source)}</figcaption></figure>`
							)
							.join("")}</div>`
					: ""
			}${Object.entries(data)
				.map(([key, value]) =>
					linkedDetail(
						title(key),
						value,
						{
							visits: "visits",
							collections: "collections",
							expenses: "expenses",
							ledger: "ledger",
							gps: "gps",
						}[key]
					)
				)
				.join("")}`
		);
		bindLinkedDetails(d);
		if (dataset === "duties" && window.SmartDSRRoute)
			window.SmartDSRRoute.mount(d, () => api("duty_route", { duty: r.name }));
	}
	function exportFile(type) {
		const params = new URLSearchParams({
			report: s.report,
			filters: JSON.stringify(s.filters),
			file_type: type,
		});
		window.open(
			"/api/method/srv_erp.smart_dsr.admin.export_report?" + params,
			"_blank",
			"noopener"
		);
	}
	function bind() {
		bindDateInputs(root);
		const form = root.querySelector("#admin-filters");
		const toDisplay = form.querySelector('[data-date-display="to_date"]');
		const clearRangeError = () => {
			if (toDisplay && !toDisplay.dataset.invalidDate) toDisplay.setCustomValidity("");
		};
		const dates = () => {
			const all = form.elements.all_dates?.checked;
			clearRangeError();
			for (const key of ["from_date", "to_date"]) {
				const box = form.elements[key]?.closest("[data-admin-date]");
				box?.querySelectorAll("input, button").forEach((el) => {
					el.disabled = !!all;
				});
			}
		};
		dates();
		if (form.elements.all_dates) form.elements.all_dates.onchange = dates;
		form.oninput = clearRangeError;
		if (form.elements.report)
			form.elements.report.onchange = () => {
				rememberFilters();
				s.report = form.elements.report.value;
				restoreFilters();
				run(load);
			};
		form.onsubmit = (e) => {
			e.preventDefault();
			if (form.dataset.dealersLoading) return;
			const values = Object.fromEntries(new FormData(e.target));
			if (
				!values.all_dates &&
				values.from_date &&
				values.to_date &&
				values.from_date > values.to_date
			) {
				toDisplay.setCustomValidity("To Date must be on or after From Date.");
				form.reportValidity();
				return;
			}
			delete values.report;
			values.all_dates =
				(["people", "vehicles", "balances"].includes(filterKind()) &&
					s.page !== "overview") ||
				!!values.all_dates;
			s.filters = values;
			rememberFilters();
			s.number = 1;
			run(load);
		};

		if (form.querySelector(".dealer-picker")) {
			const picker = bindDealerPicker(form);
			s.dealerCleanup = picker.destroy;
			let dealerLookup = 0;
			form.elements.account.onchange = async () => {
				const marker = ++dealerLookup,
					apply = form.querySelector('button[type="submit"]');
				picker.setDisabled(true);
				apply.disabled = true;
				form.dataset.dealersLoading = "1";
				try {
					const result = await api("visit_dealer_options", {
						account: form.elements.account.value || null,
						dataset: filterKind(),
					});
					if (!form.isConnected || marker !== dealerLookup) return;
					s.visitDealers = Array.isArray(result) ? result : [];
					picker.setOptions(s.visitDealers);
				} catch (error) {
					if (form.isConnected && marker === dealerLookup) showError(error.message);
				} finally {
					if (form.isConnected && marker === dealerLookup) {
						picker.setDisabled(false);
						apply.disabled = false;
						delete form.dataset.dealersLoading;
					}
				}
			};
		}
		root.querySelectorAll("[data-action]").forEach(
			(button) =>
				(button.onclick = () =>
					run(async () => {
						const action = button.dataset.action;
						if (action === "clear-filters") {
							s.filters = defaultFilters();
							rememberFilters();
							s.number = 1;
							await load();
						} else if (action === "previous") {
							s.number--;
							await load();
						} else if (action === "next") {
							s.number++;
							await load();
						} else if (action === "detail")
							await view(button.dataset.dataset, button.dataset.name);
						else if (action === "add-vehicle") manageVehicle();
						else if (action === "opening-add" || action === "opening-return")
							await openingMovement(
								action === "opening-add" ? "add" : "return",
								button.dataset.user || ""
							);
						else if (action === "xlsx" || action === "pdf") exportFile(action);
					}))
		);
	}
	window.addEventListener("hashchange", () => {
		rememberFilters();
		const next = location.hash.slice(1);
		s.page = nav.some(([id]) => id === next) ? next : "overview";
		s.number = 1;
		restoreFilters();
		run(load);
	});
	api("bootstrap")
		.then((profile) => {
			s.profile = profile;
			restoreFilters();
			return load();
		})
		.catch((e) => {
			root.innerHTML = `<main class="denied"><h1>Smart DSR Administrator</h1><p role="alert">${esc(
				e.message
			)}</p><a href="/app/home" target="_top">Return to Smart DSR</a></main>`;
		});
})();
