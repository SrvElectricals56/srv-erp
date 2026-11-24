window.smartDsrExpenses = {
	render(root, { state, active, dutyName, duties, fetch, add, details }) {
		const esc = (value) =>
			String(value ?? "").replace(
				/[&<>"']/g,
				(char) =>
					({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
			);
		const amount = (value, currency) =>
			new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
				Number(value || 0)
			);
		const date = (value) =>
			value
				? new Date(String(value).replace(" ", "T")).toLocaleString("en-IN", {
						timeZone: "Asia/Kolkata",
						year: "numeric",
						month: "short",
						day: "2-digit",
						hour: "2-digit",
						minute: "2-digit",
						hour12: true,
				  })
				: "—";
		state.filters ||= {
			search: "",
			from_date: "",
			to_date: "",
			category: "",
			status: "",
			duty: "",
		};
		state.start ||= 0;
		let generation = 0;
		root.innerHTML = `<section class="panel"><div class="section-title"><h2>Expenses</h2><div class="expense-page-actions"><button type="button" data-refresh-expenses>Refresh</button><button type="button" class="primary" data-add-expense ${
			active ? "" : "disabled"
		}>Add Expense</button></div></div><p>Recorded expenses across all your DSRs, including automatic meal and night-stay expenses.</p><p class="hint">${
			active
				? "New expenses are added to active DSR " +
				  esc(dutyName) +
				  ". A live receipt photo is required."
				: "Start duty in Smart DSR to add an expense. Previous expenses remain available below."
		}</p><form data-expense-filters></form><div data-expense-error role="alert" hidden></div><div class="expense-page-totals" aria-live="polite"></div><p data-expense-status role="status"></p><div class="table-scroll expense-page-table"></div><div class="expense-page-pagination"><button type="button" data-expense-previous>Previous</button><button type="button" data-expense-next>Next</button></div></section>`;
		const form = root.querySelector("form"),
			error = root.querySelector("[data-expense-error]"),
			table = root.querySelector(".expense-page-table");
		const previous = root.querySelector("[data-expense-previous]"),
			next = root.querySelector("[data-expense-next]");
		function renderFilters(categories = []) {
			const f = state.filters;
			const choices = [...new Set([...categories, f.category].filter(Boolean))].sort();
			form.innerHTML = `<div class="expense-page-filters"><label class="expense-page-search">Search Expenses<input type="search" name="search" placeholder="Type, remarks, expense ID or DSR" value="${esc(
				f.search
			)}"></label><label>From Date<input type="date" name="from_date" value="${esc(
				f.from_date
			)}"></label><label>To Date<input type="date" name="to_date" value="${esc(
				f.to_date
			)}"></label><label>Expense Type<select name="category" aria-label="Expense Type"><option value="">All types</option>${choices
				.map(
					(value) =>
						`<option value="${esc(value)}" ${
							f.category === value ? "selected" : ""
						}>${esc(value)}</option>`
				)
				.join(
					""
				)}</select></label><label>Status<select name="status" aria-label="Status">${[
				["", "All statuses"],
				["Recorded", "Recorded"],
				["Reversed", "Reversed"],
			]
				.map(
					([value, label]) =>
						`<option value="${value}" ${
							f.status === value ? "selected" : ""
						}>${label}</option>`
				)
				.join(
					""
				)}</select></label><label>DSR<select name="duty" aria-label="DSR"><option value="">All DSRs</option>${(
				duties || []
			)
				.map(
					(duty) =>
						`<option value="${esc(duty.name)}" ${
							f.duty === duty.name ? "selected" : ""
						}>${esc(duty.work_date)} · ${esc(duty.name)}</option>`
				)
				.join(
					""
				)}</select></label><div class="expense-page-actions"><button type="submit" class="primary">Apply Filters</button><button type="button" data-clear-expenses>Clear Filters</button></div></div>`;
			form.oninput = () => form.elements.to_date.setCustomValidity("");
			form.onsubmit = (event) => {
				event.preventDefault();
				const values = Object.fromEntries(new FormData(form));
				form.elements.to_date.setCustomValidity(
					values.from_date && values.to_date && values.from_date > values.to_date
						? "To Date must be on or after From Date."
						: ""
				);
				if (!form.reportValidity()) return;
				state.filters = values;
				state.start = 0;
				void load();
			};
			form.querySelector("[data-clear-expenses]").onclick = () => {
				state.filters = {
					search: "",
					from_date: "",
					to_date: "",
					category: "",
					status: "",
					duty: "",
				};
				state.start = 0;
				void load();
			};
		}
		async function load() {
			const request = ++generation;
			error.hidden = true;
			root.querySelector("[data-expense-status]").textContent = "Loading expenses…";
			previous.disabled = true;
			next.disabled = true;
			try {
				const result = await fetch({ ...state.filters, start: state.start });
				if (request !== generation || !root.isConnected) return;
				if (state.start && !result.rows.length) {
					state.start = 0;
					return load();
				}
				renderFilters(result.categories);
				root.querySelector("[data-expense-status]").textContent = result.totals.count
					? `Showing ${state.start + 1}–${state.start + result.rows.length} of ${
							result.totals.count
					  } expenses. Totals cover all matching records; reversed amounts are excluded from total expenses.`
					: "No expenses match your filters.";
				root.querySelector(".expense-page-totals").innerHTML = [
					["Total Expenses", amount(result.totals.amount, result.currency)],
					["Expense Records", result.totals.count],
					["Reversed Amount", amount(result.totals.reversed_amount, result.currency)],
				]
					.map(
						([label, value]) =>
							`<div class="metric"><span>${label}</span><strong>${esc(
								value
							)}</strong></div>`
					)
					.join("");
				table.innerHTML = `<table><thead><tr>${[
					"Date",
					"Expense Type",
					"Amount",
					"Status",
					"DSR",
					"Remarks",
					"Receipt",
					"Details",
				]
					.map((label) => `<th>${label}</th>`)
					.join("")}</tr></thead><tbody>${
					result.rows
						.map(
							(row, index) =>
								`<tr><td data-label="Date">${esc(
									date(row.recorded_at)
								)}</td><td data-label="Expense Type">${esc(
									row.category
								)}</td><td data-label="Amount">${esc(
									amount(row.amount, result.currency)
								)}</td><td data-label="Status">${esc(
									row.posting_status || "Recorded"
								)}</td><td data-label="DSR"><div>${esc(
									row.work_date || "—"
								)}<small>${esc(
									row.duty || "—"
								)}</small></div></td><td data-label="Remarks">${esc(
									row.remarks || "—"
								)}</td><td data-label="Receipt">${
									row.receipt?.startsWith("/private/files/")
										? `<a href="${esc(
												row.receipt
										  )}" target="_blank" rel="noopener">View Receipt</a>`
										: "—"
								}</td><td data-label="Details"><button type="button" data-expense-detail="${index}">View Details</button></td></tr>`
						)
						.join("") ||
					'<tr><td colspan="8" class="empty">No expenses found.</td></tr>'
				}</tbody></table>`;
				table.querySelectorAll("[data-expense-detail]").forEach((button) => {
					button.onclick = () =>
						details(
							result.rows[Number(button.dataset.expenseDetail)],
							result.currency
						);
				});
				previous.disabled = state.start === 0;
				next.disabled = state.start + result.rows.length >= Number(result.totals.count);
			} catch (failure) {
				if (request !== generation || !root.isConnected) return;
				error.textContent =
					failure.message || "Could not load expenses. Refresh to retry.";
				error.hidden = false;
				root.querySelector("[data-expense-status]").textContent =
					"Expense list could not be refreshed.";
			}
		}
		root.querySelector("[data-add-expense]").onclick = () => {
			if (active) add();
		};
		root.querySelector("[data-refresh-expenses]").onclick = () => {
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
		renderFilters();
		void load();
	},
};
