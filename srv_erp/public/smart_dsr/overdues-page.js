/* Allocated-dealer overdues use the same server endpoint as the Smart DSR badge. */
window.smartDsrOverdues = {
	render(root, { data, employee, refresh, details }) {
		const esc = (value) =>
			String(value ?? "").replace(
				/[&<>"']/g,
				(char) =>
					({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char])
			);
		const money = (value, currency) =>
			new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
				Number(value || 0)
			);
		let result = data || { rows: [] };
		let filters = { search: "", aging: "", minimum: "", maximum: "" };
		let start = 0,
			refreshing = false;
		root.innerHTML = `<section class="panel"><div class="section-title"><h2>Party Overdues</h2><button type="button" data-refresh-overdues>Refresh</button></div><p>Manually recorded overdue balances for dealers allocated to ${esc(
			employee || "you"
		)}.</p><div data-overdue-error role="alert" hidden></div><form data-overdue-filters></form><div class="overdue-page-totals" aria-live="polite"></div><p data-overdue-status role="status"></p><div class="table-scroll dealer-overdues-table overdues-page-table"></div><div class="overdue-page-pagination"><button type="button" data-overdue-previous>Previous</button><button type="button" data-overdue-next>Next</button></div></section>`;
		const form = root.querySelector("form");
		const error = root.querySelector("[data-overdue-error]");
		const table = root.querySelector(".overdues-page-table");
		const previous = root.querySelector("[data-overdue-previous]");
		const next = root.querySelector("[data-overdue-next]");
		function renderFilters() {
			const select = (name, label, values) =>
				`<label>${label}<select name="${name}" aria-label="${esc(
					label
				)}"><option value="">All</option>${values
					.map(
						([value, label]) =>
							`<option value="${esc(value)}" ${
								filters[name] === value ? "selected" : ""
							}>${esc(label)}</option>`
					)
					.join("")}</select></label>`;
			form.innerHTML = `<div class="overdue-page-filters"><label class="overdue-page-search">Search Party / Customer<input type="search" name="search" placeholder="Party name or code" value="${esc(
				filters.search
			)}"></label>${select("aging", "Days Overdue", [
				["1-30", "1–30 days"],
				["31-60", "31–60 days"],
				["61-90", "61–90 days"],
				["91+", "91+ days"],
			])}<label>Minimum Overdue<input type="number" name="minimum" min="0" step="0.01" value="${esc(
				filters.minimum
			)}"></label><label>Maximum Overdue<input type="number" name="maximum" min="0" step="0.01" value="${esc(
				filters.maximum
			)}"></label><div class="overdue-page-filter-actions"><button type="submit" class="primary">Apply Filters</button><button type="button" data-clear-overdues>Clear Filters</button></div></div>`;
			form.querySelector("[data-clear-overdues]").onclick = () => {
				filters = { search: "", aging: "", minimum: "", maximum: "" };
				start = 0;
				renderFilters();
				renderRows();
			};
			form.oninput = () => form.elements.maximum.setCustomValidity("");
			form.onsubmit = (event) => {
				event.preventDefault();
				const values = Object.fromEntries(new FormData(form));
				form.elements.maximum.setCustomValidity(
					values.minimum !== "" &&
						values.maximum !== "" &&
						Number(values.minimum) > Number(values.maximum)
						? "Maximum Overdue must be at least Minimum Overdue."
						: ""
				);
				if (!form.reportValidity()) return;
				filters = values;
				start = 0;
				renderRows();
			};
		}
		function renderRows() {
			const search = filters.search.trim().toLocaleLowerCase();
			const rows = (result.rows || []).filter((row) => {
				const days = Number(row.days_overdue),
					amount = Number(row.overdue_amount);
				const aging =
					!filters.aging ||
					(filters.aging === "91+"
						? days >= 91
						: days >= Number(filters.aging.split("-")[0]) &&
						  days <= Number(filters.aging.split("-")[1]));
				return (
					(!search ||
						[row.customer, row.customer_name].some((value) =>
							String(value || "")
								.toLocaleLowerCase()
								.includes(search)
						)) &&
					aging &&
					(filters.minimum === "" || amount >= Number(filters.minimum)) &&
					(filters.maximum === "" || amount <= Number(filters.maximum))
				);
			});
			const totals = {};
			for (const row of rows)
				totals[row.currency] = (totals[row.currency] || 0) + Number(row.overdue_amount);
			root.querySelector(
				".overdue-page-totals"
			).innerHTML = `<div class="metric"><span>Dealers / Parties</span><strong>${
				new Set(rows.map((row) => row.customer)).size
			}</strong></div><div class="metric"><span>Overdue Entries</span><strong>${rows.reduce(
				(total, row) => total + Number(row.entry_count || 0),
				0
			)}</strong></div>${Object.entries(totals)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(
					([currency, value]) =>
						`<div class="metric"><span>Total Overdue · ${esc(
							currency
						)}</span><strong>${esc(money(value, currency))}</strong></div>`
				)
				.join("")}`;
			const page = rows.slice(start, start + 50);
			root.querySelector("[data-overdue-status]").textContent = rows.length
				? `Showing ${start + 1}–${start + page.length} of ${
						rows.length
				  } dealer/currency balances. Totals cover all matching balances.`
				: "No overdue amounts match your filters.";
			table.innerHTML = `<table><thead><tr><th>Dealer / Party</th><th>Overdue Amount</th><th>Entries</th><th>Oldest Due Date</th><th>Days Overdue</th><th>Details</th></tr></thead><tbody>${
				page
					.map(
						(row, index) =>
							`<tr><td data-label="Dealer / Party"><div>${esc(
								row.customer_name
							)}<small>${esc(
								row.customer
							)}</small></div></td><td data-label="Overdue Amount">${esc(
								money(row.overdue_amount, row.currency)
							)}</td><td data-label="Entries">${Number(
								row.entry_count || 0
							)}</td><td data-label="Oldest Due Date">${esc(
								row.oldest_due_date
							)}</td><td data-label="Days Overdue">${Number(
								row.days_overdue
							)}</td><td data-label="Details"><button type="button" data-overdue-detail="${index}">View Dues</button></td></tr>`
					)
					.join("") ||
				'<tr><td colspan="6" class="empty">No overdue amounts for your allocated dealers match these filters.</td></tr>'
			}</tbody></table>`;
			table.querySelectorAll("[data-overdue-detail]").forEach((button) => {
				button.onclick = async () => {
					button.disabled = true;
					error.hidden = true;
					try {
						await details(page[Number(button.dataset.overdueDetail)]);
					} catch (failure) {
						error.textContent =
							failure.message || "Could not load dealer dues. Please retry.";
						error.hidden = false;
					} finally {
						button.disabled = false;
					}
				};
			});
			previous.disabled = start === 0;
			next.disabled = start + 50 >= rows.length;
		}
		previous.onclick = () => {
			start = Math.max(0, start - 50);
			renderRows();
		};
		next.onclick = () => {
			start += 50;
			renderRows();
		};
		root.querySelector("[data-refresh-overdues]").onclick = async (event) => {
			if (refreshing) return;
			refreshing = true;
			event.currentTarget.disabled = true;
			error.hidden = true;
			try {
				result = await refresh();
				start = 0;
				renderFilters();
				renderRows();
			} catch (failure) {
				error.textContent = failure.message || "Could not refresh overdues. Please retry.";
				error.hidden = false;
			} finally {
				refreshing = false;
				root.querySelector("[data-refresh-overdues]").disabled = false;
			}
		};
		renderFilters();
		renderRows();
	},
};
