window.smartDsrPartyItems = {
	render(root, { fetch, options }) {
		const esc = (value) =>
			String(value ?? "").replace(
				/[&<>"']/g,
				(char) =>
					({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
			);
		const quantity = (value) =>
			Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 9 });
		const currentMonth = (options.today || new Date().toISOString().slice(0, 10)).slice(0, 7);
		let state = {
			source: options.sources[0]?.value || "orders",
			view: "items",
			search: "",
			customer: "",
			item_code: "",
			from_date: "",
			to_date: "",
			interval: "",
			period: currentMonth,
			start: 0,
		};
		let previousState = null,
			generation = 0;
		root.innerHTML = `<section class="panel"><div class="section-title"><h2>Party Top Items</h2><button type="button" data-party-refresh>Refresh</button></div><p>Product quantities and purchase dates for customers allocated to you. Quantity totals keep stock UOMs separate.</p><form data-party-filters></form><div class="party-items-views"><button type="button" data-view="items">Top Items</button><button type="button" data-view="purchases">Purchase History</button><button type="button" data-party-back hidden>Back to Top Items</button></div><p data-party-source-note class="hint"></p><div data-party-error role="alert" hidden></div><div class="party-items-metrics" aria-live="polite"></div><p data-party-status role="status"></p><div class="table-scroll party-items-table"></div><div class="party-items-pagination"><button type="button" data-party-previous>Previous</button><button type="button" data-party-next>Next</button></div></section>`;
		const form = root.querySelector("form"),
			error = root.querySelector("[data-party-error]"),
			table = root.querySelector(".party-items-table");
		const previous = root.querySelector("[data-party-previous]"),
			next = root.querySelector("[data-party-next]");
		function filters() {
			const select = (name, label, values, all) =>
				`<label>${label}<select name="${name}" aria-label="${label}">${
					all ? `<option value="">${all}</option>` : ""
				}${values
					.map(
						([value, label]) =>
							`<option value="${esc(value)}" ${
								state[name] === value ? "selected" : ""
							}>${esc(label)}</option>`
					)
					.join("")}</select></label>`;
			form.innerHTML = `<div class="party-items-filters"><label class="party-items-search">Search<input type="search" name="search" placeholder="Party, product or document" value="${esc(
				state.search
			)}"></label>${select(
				"interval",
				"Interval",
				[
					["monthly", "Monthly"],
					["quarterly", "Quarterly"],
					["half-yearly", "Half Yearly"],
					["yearly", "Yearly"],
				],
				"Custom / All dates"
			)}<div class="party-customer-picker"><label>Party / Customer<input type="search" data-party-customer-input role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="party-customer-options" placeholder="Search by name or choose a party" autocomplete="off" value="${esc(
				state.customer
			)}"></label><div id="party-customer-options" class="party-customer-dropdown" role="listbox" hidden></div><input type="hidden" name="customer" value="${esc(
				state.customer
			)}"></div><label>Product Code<input name="item_code" type="text" placeholder="Exact item code" value="${esc(
				state.item_code
			)}"></label><label>From Date<input type="date" name="from_date" value="${esc(
				state.from_date
			)}"></label><label>To Date<input type="date" name="to_date" value="${esc(
				state.to_date
			)}"></label><div class="party-items-actions"><button type="submit" class="primary">Apply Filters</button><button type="button" data-party-clear>Clear Filters</button></div></div>`;
			const customerInput = form.querySelector("[data-party-customer-input]");
			const resolveCustomer = () => {
				const value = customerInput.value.trim();
				const matches = options.customers.filter(
					(row) =>
						row.name === value ||
						String(row.customer_name || "").toLocaleLowerCase() ===
							value.toLocaleLowerCase()
				);
				const selected =
					matches.find((row) => row.name === value) ||
					(matches.length === 1 ? matches[0] : null);
				form.elements.customer.value = selected ? selected.name : "";
				customerInput.setCustomValidity(
					value && !selected ? "Choose an allocated party from the list." : ""
				);
			};
			const customerMenu = form.querySelector(".party-customer-dropdown");
			let activeOption = -1;
			const closeCustomers = () => {
				customerMenu.hidden = true;
				customerInput.setAttribute("aria-expanded", "false");
				customerInput.removeAttribute("aria-activedescendant");
				activeOption = -1;
			};
			const openCustomers = () => {
				const term = customerInput.value.trim().toLocaleLowerCase();
				const rows = options.customers.filter(
					(row) =>
						!term ||
						[row.name, row.customer_name].some((value) =>
							String(value || "")
								.toLocaleLowerCase()
								.includes(term)
						)
				);
				customerMenu.innerHTML =
					'<button type="button" role="option" data-customer="">All parties</button>' +
					rows
						.map(
							(row, index) =>
								`<button type="button" role="option" id="party-option-${index}" data-customer="${esc(
									row.name
								)}">${esc(row.customer_name || row.name)}${
									row.name !== row.customer_name
										? `<small>${esc(row.name)}</small>`
										: ""
								}${row.disabled ? "<small>Disabled</small>" : ""}</button>`
						)
						.join("") +
					(rows.length ? "" : "<p>No matching parties.</p>");
				customerMenu.hidden = false;
				customerInput.setAttribute("aria-expanded", "true");
				activeOption = -1;
				customerMenu.querySelectorAll("[data-customer]").forEach((button) => {
					button.onmousedown = (event) => event.preventDefault();
					button.onclick = () => {
						customerInput.value = button.dataset.customer;
						form.elements.customer.value = button.dataset.customer;
						customerInput.setCustomValidity("");
						closeCustomers();
						customerInput.focus();
					};
				});
			};
			customerInput.oninput = () => {
				customerInput.setCustomValidity("");
				form.elements.customer.value = "";
				openCustomers();
			};
			customerInput.onfocus = openCustomers;
			customerInput.onclick = openCustomers;
			customerInput.onblur = () => {
				setTimeout(() => {
					if (!customerMenu.contains(document.activeElement)) closeCustomers();
				}, 150);
			};
			customerInput.onchange = resolveCustomer;
			customerInput.onkeydown = (event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					closeCustomers();
					return;
				}
				if (["ArrowDown", "ArrowUp"].includes(event.key)) {
					event.preventDefault();
					if (customerMenu.hidden) openCustomers();
					const buttons = [...customerMenu.querySelectorAll("[data-customer]")];
					activeOption =
						(activeOption + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
						buttons.length;
					buttons.forEach((button, index) =>
						button.classList.toggle("active", index === activeOption)
					);
					buttons[activeOption].scrollIntoView({ block: "nearest" });
					return;
				}
				if (event.key === "Enter" && !customerMenu.hidden && activeOption >= 0) {
					event.preventDefault();
					customerMenu.querySelectorAll("[data-customer]")[activeOption].click();
				}
			};
			const updateInterval = () => {
				const interval = form.elements.interval.value;
				if (!interval) return;
				const [year, month] = currentMonth.split("-").map(Number);
				if (!year || !month) return;
				const months = { monthly: 1, quarterly: 3, "half-yearly": 6, yearly: 12 }[
					interval
				];
				const first = Math.floor((month - 1) / months) * months;
				form.elements.from_date.value = new Date(Date.UTC(year, first, 1))
					.toISOString()
					.slice(0, 10);
				form.elements.to_date.value = new Date(Date.UTC(year, first + months, 0))
					.toISOString()
					.slice(0, 10);
				form.elements.to_date.setCustomValidity("");
			};
			form.elements.interval.onchange = updateInterval;
			form.oninput = (event) => {
				form.elements.to_date.setCustomValidity("");
				if (["from_date", "to_date"].includes(event.target.name)) {
					form.elements.interval.value = "";
				}
			};
			form.onsubmit = (event) => {
				event.preventDefault();
				resolveCustomer();
				const values = Object.fromEntries(new FormData(form));
				form.elements.to_date.setCustomValidity(
					values.from_date && values.to_date && values.from_date > values.to_date
						? "To Date must be on or after From Date."
						: ""
				);
				if (!form.reportValidity()) return;
				state = { ...state, ...values, period: currentMonth, start: 0 };
				previousState = null;
				void load();
			};
			form.querySelector("[data-party-clear]").onclick = () => {
				state = {
					source: state.source,
					view: state.view,
					search: "",
					customer: "",
					item_code: "",
					from_date: "",
					to_date: "",
					interval: "",
					period: currentMonth,
					start: 0,
				};
				previousState = null;
				filters();
				void load();
			};
		}
		async function load() {
			const request = ++generation;
			error.hidden = true;
			previous.disabled = true;
			next.disabled = true;
			root.querySelector("[data-party-status]").textContent = "Loading party items…";
			root.querySelectorAll("[data-view]").forEach((button) => {
				button.classList.toggle("primary", button.dataset.view === state.view);
				button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
			});
			root.querySelector("[data-party-back]").hidden = !previousState;
			root.querySelector("[data-party-source-note]").textContent =
				state.source === "orders"
					? "Submitted sales orders show ordered quantities. Drafts and cancelled orders are excluded."
					: "Submitted sales invoices show invoiced quantities. Returns are negative and reduce net totals. Drafts and cancelled invoices are excluded.";
			try {
				const result = await fetch(state);
				if (request !== generation || !root.isConnected) return;
				if (state.start && !result.rows.length) {
					state.start = 0;
					return load();
				}
				const metrics = result.metrics;
				root.querySelector(".party-items-metrics").innerHTML = [
					["Parties", metrics.parties],
					["Products", metrics.products],
					[
						state.source === "orders" ? "Sales Orders" : "Sales Invoices",
						metrics.documents,
					],
					...result.quantities.map((row) => [
						"Net Quantity · " + (row.uom || "Unspecified UOM"),
						quantity(row.qty),
					]),
				]
					.map(
						([label, value]) =>
							`<div class="metric"><span>${esc(label)}</span><strong>${esc(
								value
							)}</strong></div>`
					)
					.join("");
				root.querySelector("[data-party-status]").textContent = result.count
					? `Showing ${state.start + 1}–${state.start + result.rows.length} of ${
							result.count
					  } ${
							state.view === "items" ? "party/product totals" : "purchase lines"
					  }. Totals cover all matching records.`
					: "No submitted purchases match your filters.";
				if (state.view === "items") {
					table.innerHTML = `<table><thead><tr>${[
						"Party / Customer",
						"Product",
						"Net Quantity",
						"Stock UOM",
						state.source === "orders" ? "Orders" : "Invoices",
						"First Date",
						"Latest Date",
						"Details",
					]
						.map((label) => `<th>${label}</th>`)
						.join("")}</tr></thead><tbody>${
						result.rows
							.map(
								(row, index) =>
									`<tr><td data-label="Party / Customer"><div>${esc(
										row.customer_name
									)}${
										row.customer !== row.customer_name
											? `<small>${esc(row.customer)}</small>`
											: ""
									}</div></td><td data-label="Product"><div>${esc(
										row.item_name
									)}<small>${esc(
										row.item_code
									)}</small></div></td><td data-label="Net Quantity">${esc(
										quantity(row.qty)
									)}</td><td data-label="Stock UOM">${esc(
										row.uom
									)}</td><td data-label="Documents">${
										row.documents
									}</td><td data-label="First Date">${esc(
										row.first_date
									)}</td><td data-label="Latest Date">${esc(
										row.last_date
									)}</td><td data-label="Details"><button type="button" data-purchases="${index}">View Purchases</button></td></tr>`
							)
							.join("") ||
						'<tr><td colspan="8" class="empty">No purchases found.</td></tr>'
					}</tbody></table>`;
					table.querySelectorAll("[data-purchases]").forEach((button) => {
						button.onclick = () => {
							previousState = { ...state };
							const row = result.rows[Number(button.dataset.purchases)];
							state = {
								...state,
								customer: row.customer,
								item_code: row.item_code,
								view: "purchases",
								start: 0,
							};
							filters();
							void load();
						};
					});
				} else {
					const path = state.source === "orders" ? "sales-order" : "sales-invoice";
					table.innerHTML = `<table><thead><tr>${[
						state.source === "orders" ? "Order Date" : "Invoice Date",
						"Party / Customer",
						"Product",
						"Quantity",
						"UOM",
						"Stock Quantity",
						"Stock UOM",
						"Document / Company",
					]
						.map((label) => `<th>${label}</th>`)
						.join("")}</tr></thead><tbody>${
						result.rows
							.map(
								(row) =>
									`<tr><td data-label="Date">${esc(
										row.date
									)}</td><td data-label="Party / Customer">${esc(
										row.customer_name
									)}</td><td data-label="Product"><div>${esc(
										row.item_name
									)}<small>${esc(
										row.item_code
									)}</small></div></td><td data-label="Quantity">${esc(
										quantity(row.qty)
									)}</td><td data-label="UOM">${esc(
										row.uom
									)}</td><td data-label="Stock Quantity">${esc(
										quantity(row.stock_qty)
									)}</td><td data-label="Stock UOM">${esc(
										row.stock_uom
									)}</td><td data-label="Document / Company"><div><a href="/app/${path}/${encodeURIComponent(
										row.document
									)}" target="_top">${esc(row.document)}</a><small>${esc(
										row.company
									)}</small>${
										row.is_return ? "<small>Sales Return</small>" : ""
									}</div></td></tr>`
							)
							.join("") ||
						'<tr><td colspan="8" class="empty">No purchase lines found.</td></tr>'
					}</tbody></table>`;
				}
				previous.disabled = state.start === 0;
				next.disabled = state.start + result.rows.length >= result.count;
			} catch (failure) {
				if (request !== generation || !root.isConnected) return;
				error.textContent =
					failure.message || "Could not load party items. Refresh to retry.";
				error.hidden = false;
				root.querySelector("[data-party-status]").textContent =
					"Report could not be refreshed.";
			}
		}
		root.querySelectorAll("[data-view]").forEach((button) => {
			button.onclick = () => {
				state.view = button.dataset.view;
				state.start = 0;
				previousState = null;
				void load();
			};
		});
		root.querySelector("[data-party-back]").onclick = () => {
			state = previousState;
			previousState = null;
			filters();
			void load();
		};
		root.querySelector("[data-party-refresh]").onclick = () => {
			void load();
		};
		previous.onclick = () => {
			state.start = Math.max(0, state.start - 50);
			void load();
		};
		next.onclick = () => {
			state.start += 50;
			void load();
		};
		filters();
		if (!options.sources.length) {
			error.textContent =
				"You do not have permission to read Sales Orders or Sales Invoices.";
			error.hidden = false;
			root.querySelector("[data-party-status]").textContent = "No sales source available.";
			root.querySelectorAll("button,input,select").forEach(
				(control) => (control.disabled = true)
			);
			return;
		}
		void load();
	},
};
