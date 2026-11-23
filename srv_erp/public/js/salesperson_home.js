(() => {
	"use strict";
	// Discard the older cached Desk page script that redirected to the website.
	try {
		localStorage.removeItem("_page:smart-dsr");
	} catch (_) {
		// Keep the fallback when optional cached data or error details are unavailable.
	}
	$(document).on("app_ready", () => {
		if (!frappe.boot.salesperson_home) return;
		setupDsrNotifications();
		const isHome = () => {
			const route = frappe.get_route() || [];
			return route[0] === "Workspaces" && route[1] === "Home";
		};
		const homeLink = $(
			'<a class="btn btn-default btn-sm salesperson-home-link" href="/app/home">Home</a>'
		);
		$(".navbar .navbar-collapse > .navbar-nav")
			.last()
			.prepend($('<li class="nav-item salesperson-home-nav">').append(homeLink));
		const original = frappe.views.Workspace.prototype.show;
		frappe.views.Workspace.prototype.show = function () {
			this.body.children(".salesperson-home").remove();
			this.body.removeClass("salesperson-home-active");
			if (!isHome()) return original.apply(this, arguments);
			if (!this.all_pages) {
				setTimeout(() => this.show(), 100);
				return;
			}
			this.page.set_title(__("Home"));
			this.page.clear_primary_action();
			this.page.clear_secondary_action();
			this.body.addClass("salesperson-home-active");
			const panel = $('<div class="salesperson-home">').appendTo(this.body);
			panel.html(
				`<div class="salesperson-home-metrics" aria-live="polite">${[
					"Opening Balance",
					"Closing Balance",
					"Total Earn Points",
				]
					.map(
						(label) =>
							`<div class="salesperson-home-metric"><span>${__(
								label
							)}</span><strong data-metric="${label}">…</strong></div>`
					)
					.join(
						""
					)}</div><div class="salesperson-home-status" role="status"></div><div class="salesperson-home-grid"></div>`
			);
			const rewardCard = panel
				.find('[data-metric="Total Earn Points"]')
				.closest(".salesperson-home-metric");
			$(
				'<button type="button" class="salesperson-reward-eye" aria-label="View reward point calculation" title="View reward point calculation"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>'
			)
				.appendTo(rewardCard)
				.on("click", () => {
					const dialog = new frappe.ui.Dialog({
						title: __("Reward Point Calculation"),
						size: "extra-large",
						fields: [
							{
								fieldname: "reward_table",
								fieldtype: "HTML",
								options:
									'<div class="salesperson-reward-image"><img src="/assets/srv_erp/images/reward-points-table.svg?v=20261121-2" alt="Reward points table: up to 30 minutes, minus one below 20,000 rupees, one point per 40,000; up to one hour, minus one below 75,000, two points per 150,000; up to two hours, minus one below 200,000, three points per 300,000; up to three hours, minus one below 300,000, four points per 400,000; above three hours, minus one below 400,000, five points per 500,000."></div>',
							},
						],
					});
					dialog.$wrapper.addClass("salesperson-reward-dialog");
					dialog.$wrapper
						.find(".modal-header .btn-modal-close")
						.attr("aria-label", __("Close reward point calculation"));
					dialog.show();
				});

			const workflows = [
				["Smart DSR", "dsr"],
				["DSR History", "history"],
				["Collect Money", "collect"],
				["Collections", "collections"],
				["Party Overdues", "overdues"],
				["Expenses", "expenses"],
				["Make Sales Order", () => frappe.new_doc("Sales Order")],
				["Overall Sales Orders", () => frappe.set_route("List", "Sales Order")],
				["Party / Customer", () => frappe.set_route("List", "Customer")],
				["Add New Customer", () => frappe.new_doc("Customer")],
				["Party Top Items", "party-items"],
				["Item List", () => frappe.set_route("List", "Item")],
			];
			workflows.forEach(([label, action]) =>
				$('<button type="button" class="salesperson-home-tile">')
					.text(__(label))
					.appendTo(panel.find(".salesperson-home-grid"))
					.on("click", () => {
						if (typeof action === "function") return action();
						if (action === "collect") {
							void srv_erp.home_collections
								.collect({ onSave: refreshMetrics })
								.catch(() => {});
							return;
						}
						if (action === "collections") {
							this.page.set_title(__("Collections"));
							srv_erp.home_collections.show(panel, {
								onSave: refreshMetrics,
								onBack: () => {
									panel.find(".home-collections-view").remove();
									panel.find(".salesperson-home-grid").show();
									this.page.set_title(__("Home"));
									void refreshMetrics();
								},
							});
							return;
						}
						if (["history", "overdues", "expenses", "party-items"].includes(action)) {
							window.location.assign("/app/smart-dsr?section=" + action);
							return;
						}
						frappe.route_options = { smart_dsr_section: action };
						frappe.set_route("smart-dsr");
					})
			);
			const overdueTile = panel
				.find(".salesperson-home-tile")
				.filter((_, node) => node.textContent === __("Party Overdues"));
			$('<span class="salesperson-overdue-count" aria-live="polite">')
				.text("…")
				.appendTo(overdueTile);
			function refreshMetrics() {
				return frappe
					.xcall("srv_erp.smart_dsr.api.bootstrap")
					.then((data) => {
						if (!panel[0].isConnected) return;
						panel.find(".salesperson-home-status").empty();
						const money = (value) =>
							value == null
								? __("Not initialized")
								: format_currency(value, data.currency);
						panel
							.find('[data-metric="Opening Balance"]')
							.text(
								money(
									data.official_opening_balance ??
										data.current?.duty?.opening_balance
								)
							);
						panel
							.find('[data-metric="Closing Balance"]')
							.text(
								money(
									data.current?.available_cash ?? data.official_opening_balance
								)
							);
						// The same account-wide total used by Smart DSR's Reward Points.
						panel
							.find('[data-metric="Total Earn Points"]')
							.text(Number(data.reward_points || 0));
						const count = Number(data.overdue_party_count || 0);
						overdueTile
							.find(".salesperson-overdue-count")
							.text(count)
							.attr("title", __("Allocated parties with overdue balances"));
						overdueTile.attr("aria-label", __("Party Overdues: {0} parties", [count]));
					})
					.catch(() =>
						panel
							.find(".salesperson-home-status")
							.text(__("Balances could not be loaded. Open Home again to retry."))
					);
			}
			void refreshMetrics();
		};
		// A new login starts here; bookmarked document URLs continue to work.
		if (["/app", "/app/"].includes(window.location.pathname)) frappe.set_route("home");
		else if (isHome() && frappe.workspace) frappe.workspace.show();

		function setupDsrNotifications() {
			const notifications = frappe.frappe_toolbar?.notifications;
			if (!notifications || notifications.tabs.smart_dsr) return;
			const panel = $('<div class="panel-smart-dsr-notifications">')
				.hide()
				.appendTo(notifications.body);
			const tab = $('<li class="notifications-category" role="tab">').text(__("Smart DSR"));
			let loaded = false;
			let loading = false;
			let offset = 0;
			async function refresh(append = false) {
				if (loading) return;
				loading = true;
				if (!append) {
					offset = 0;
					panel
						.empty()
						.append(
							$('<p class="text-muted p-3">').text(__("Loading notifications…"))
						);
				}
				try {
					const rows = await frappe.xcall("srv_erp.smart_dsr.home.notifications", {
						start: offset,
					});
					if (!append) panel.empty();
					panel.find(".smart-dsr-load-more").remove();
					rows.forEach((row) => {
						const item = $(
							'<button type="button" class="recent-item notification-item smart-dsr-notification">'
						);
						$("<strong>").text(row.event_type).appendTo(item);
						$('<span class="text-muted">')
							.text(frappe.datetime.str_to_user(row.recorded_at))
							.appendTo(item);
						if (row.details) $("<span>").text(row.details).appendTo(item);
						item.on("click", () =>
							window.location.assign(
								row.duty
									? "/app/smart-dsr?duty=" + encodeURIComponent(row.duty)
									: "/app/home"
							)
						);
						panel.append(item);
					});
					offset += rows.length;
					if (!offset)
						panel.append(
							$('<p class="text-muted p-3">').text(__("No Smart DSR notifications."))
						);
					if (rows.length === 100)
						$(
							'<button type="button" class="btn btn-default btn-sm smart-dsr-load-more">'
						)
							.text(__("Load older notifications"))
							.appendTo(panel)
							.on("click", (event) => {
								event.stopPropagation();
								void refresh(true);
							});
					loaded = true;
				} catch (_) {
					panel.append(
						$('<button type="button" class="btn btn-default btn-sm">')
							.text(__("Could not load notifications. Retry"))
							.on("click", (event) => {
								event.stopPropagation();
								void refresh();
							})
					);
				} finally {
					loading = false;
				}
			}
			const category = { id: "smart_dsr", $tab: tab };
			notifications.categories.push(category);
			notifications.tabs.smart_dsr = {
				show() {
					panel.show();
					if (!loaded) void refresh();
				},
				hide() {
					panel.hide();
				},
			};
			tab.appendTo(notifications.header_items.find(".notification-item-tabs")).on(
				"click",
				(event) => {
					event.stopImmediatePropagation();
					notifications.switch_tab(category);
				}
			);
			notifications.dropdown.on("show.bs.dropdown.smart_dsr", () => {
				if (tab.hasClass("active")) void refresh();
				else loaded = false;
			});
		}
	});
})();
