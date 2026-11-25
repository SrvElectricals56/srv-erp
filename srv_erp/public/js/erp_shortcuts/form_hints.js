import { get_form_controls } from "./fields.js";

const TAB_HINT_CLASS = "srv-erp-form-tab-shortcut-hint";

function decorate_tab_hint(frm, tabs) {
	const tab_list = frm.layout?.tab_link_container?.get?.(0);
	const tab_bar = tab_list?.closest(".form-tabs-list");
	if (!tab_bar) {
		return;
	}

	const hint = tab_bar.querySelector(`:scope > .${TAB_HINT_CLASS}`);
	tab_bar.classList.toggle("srv-erp-tab-navigation", tabs.length > 1);
	if (tabs.length < 2) {
		hint?.remove();
		tab_list.removeAttribute("aria-keyshortcuts");
		return;
	}

	tab_list.setAttribute("aria-keyshortcuts", "Alt+M");
	if (!hint) {
		const instructions = document.createElement("span");
		instructions.className = TAB_HINT_CLASS;
		instructions.textContent = frm.doctype === "Sales Order"
			? "Alt+M\u00a0\u00a0↑ ↓ ← →"
			: "Alt+M\u00a0\u00a0←\u00a0→";
		instructions.title = frm.doctype === "Sales Order"
			? __("Alt+M starts at Customer. Use the arrow keys to move between fields.")
			: __("Press Alt+M, then Left or Right to switch tabs");
		instructions.setAttribute("aria-label", instructions.title);
		tab_bar.append(instructions);
	}
}

function decorate_hints(wrapper, target_nodes, type, shortcut, help) {
	const class_name = `srv-erp-form-${type}-shortcut-hint`;
	for (const hint of wrapper.querySelectorAll(`.${class_name}`)) {
		if (!target_nodes.has(hint.parentElement)) {
			hint.remove();
		}
	}
	for (const node of target_nodes) {
		if (!node.querySelector(`:scope > .${class_name}`)) {
			const hint = document.createElement("span");
			hint.className = class_name;
			hint.textContent = shortcut;
			hint.title = help;
			node.append(hint);
		}
	}
}

export function decorate_form_hints(frm, wrapper, tabs, section_head, selected_section) {
	decorate_tab_hint(frm, tabs);
	decorate_hints(
		wrapper, new Set(section_head ? [section_head] : []),
		"section", "Alt+H", __("Press Alt+H, then Up or Down to move between headings")
	);
	const contexts = selected_section ? [null] : tabs.length ? tabs : [null];
	const input_wrappers = contexts
		.map((tab) => get_form_controls(frm, tab, selected_section)[0]?.closest(".frappe-control"))
		.filter(Boolean);
	decorate_hints(
		wrapper, new Set(input_wrappers), "field", "Alt+D", __("Press Alt+D to focus this field")
	);
}
