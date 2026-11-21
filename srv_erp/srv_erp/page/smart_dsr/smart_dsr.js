// Smart DSR always opens through Desk, retaining its normal page permissions.
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
	page.main.append(frame);
};
frappe.pages["smart-dsr"].on_page_show = function (wrapper) {
	if (!wrapper.smart_dsr_frame) return;
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
			: "Smart DSR";
	wrapper.page.set_title(__(title));
	wrapper.smart_dsr_frame.title = __(title);
	const hash = duty ? "#dsr/" + encodeURIComponent(duty) : window.location.hash;
	const src = `/smart-dsr-content?desk=1&section=${encodeURIComponent(section)}${hash}`;
	if (wrapper.smart_dsr_frame.getAttribute("src") !== src) wrapper.smart_dsr_frame.src = src;
};
