// Smart DSR always opens through Desk, retaining its normal page permissions.
frappe.smart_dsr_breadcrumbs = function (title, adminSection, section) {
	const items = [{ route: "/app/home", label: __("Home") }];
	if (frappe.get_route()[1] === "admin") {
		items.push({ route: "/app/smart-dsr/admin", label: __("Smart DSR Admin") });
		if (adminSection) items.push(adminSection);
	} else {
		items.push({ route: "/app/smart-dsr", label: __("Smart DSR") });
		if (title !== "Smart DSR")
			items.push({ route: "/app/smart-dsr?section=" + encodeURIComponent(section), label: __(title) });
	}
	if (!frappe.breadcrumbs.smart_dsr_renderer) {
		const original = frappe.breadcrumbs.set_custom_breadcrumbs;
		frappe.breadcrumbs.set_custom_breadcrumbs = function (breadcrumbs) {
			if (!breadcrumbs.smart_dsr_items) return original.call(this, breadcrumbs);
			breadcrumbs.smart_dsr_items.forEach((item) =>
				this.append_breadcrumb_element(item.route, item.label)
			);
		};
		frappe.breadcrumbs.smart_dsr_renderer = true;
	}
	frappe.breadcrumbs.add({ type: "Custom", smart_dsr_items: items });
};

frappe.pages["smart-dsr"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Smart DSR"),
		single_column: true,
	});
	page.main.addClass("smart-dsr-desk-content");
	const frame = document.createElement("iframe");
	frame.title = __("Smart DSR");
	frame.allow = "geolocation; camera";
	frame.className = "salesperson-home-frame smart-dsr-desk-frame";
	wrapper.smart_dsr_frame = frame;
	frame.addEventListener("load", () => {
		if (frappe.get_route()[0] !== "smart-dsr" || frappe.get_route()[1] !== "admin") return;
		const update = () => {
			if (frappe.get_route()[0] !== "smart-dsr" || frappe.get_route()[1] !== "admin") return;
			const sections = {
				overview: "Overview", people: "Salespersons", balances: "Opening Balances",
				vehicles: "Vehicles", duties: "Duty Records", visits: "Party Visits",
				collections: "Collections", expenses: "Expenses", dsrs: "DSR Records",
				reports: "Reports", audit: "Audit Logs",
			};
			const section = frame.contentWindow.location.hash.slice(1) || "overview";
			const label = sections[section] || "Overview";
			frappe.smart_dsr_breadcrumbs("Smart DSR Admin", {
				route: "/app/smart-dsr/admin#" + (sections[section] ? section : "overview"),
				label: __(label),
			});
		};
		frame.contentWindow.addEventListener("hashchange", update);
		wrapper.smart_dsr_update_breadcrumbs = update;
		update();
	});
	page.main.append(frame);
};
frappe.pages["smart-dsr"].on_page_show = function (wrapper) {
	if (!wrapper.smart_dsr_frame) return;
	if (frappe.get_route()[1] === "admin") {
		frappe.smart_dsr_breadcrumbs("Smart DSR Admin");
		wrapper.page.set_title(__("Smart DSR Admin"));
		wrapper.page.set_secondary_action(__("Back"), () => {
			if (window.history.length > 1) window.history.back();
			else frappe.set_route("home");
		}, "arrow-left");
		wrapper.smart_dsr_frame.title = __("Smart DSR Admin");
		const src = "/smart-dsr-admin?desk=1" + window.location.hash;
		if (wrapper.smart_dsr_frame.getAttribute("src") !== src)
			wrapper.smart_dsr_frame.src = src;
		else wrapper.smart_dsr_update_breadcrumbs?.();
		return;
	}
	wrapper.page.clear_secondary_action();
	const query = new URLSearchParams(window.location.search);
	const options = frappe.route_options || {};
	const section = options.smart_dsr_section || query.get("section") || "dsr";
	const duty = query.get("duty");
	delete options.smart_dsr_section;
	const title =
		section === "history"
			? "Previous DSRs"
			: section === "overdues"
			? "Overdues"
			: section === "expenses"
			? "Expenses"
			: section === "party-items"
			? "Party Top Items"
		: section === "collections"
		? "Collections"
		: section === "collect"
		? "Collect Money"
			: "Smart DSR";
	wrapper.page.set_title(__(title));
	frappe.smart_dsr_breadcrumbs(title, null, section);
	wrapper.smart_dsr_frame.title = __(title);
	const hash = duty
		? "#dsr/" + encodeURIComponent(duty)
		: window.location.hash || (section === "dsr" ? "#new-dsr" : "");
	const src = `/smart-dsr-content?desk=1&section=${encodeURIComponent(section)}${hash}`;
	if (wrapper.smart_dsr_frame.getAttribute("src") !== src) wrapper.smart_dsr_frame.src = src;
};
