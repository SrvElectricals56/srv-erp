const TAB_HINT_CLASS = "srv-erp-form-tab-shortcut-hint";

function decorate_tab_hint(frm, tabs) {
	const tab_list = frm.layout?.tab_link_container?.get?.(0);
	const tab_bar = tab_list?.closest(".form-tabs-list");
	if (!tab_bar) {
		return;
	}

	const hint = tab_bar.querySelector(`:scope > .${TAB_HINT_CLASS}`);
	tab_bar.classList.toggle("srv-erp-tab-navigation", tabs.length > 0);
	if (!tabs.length) {
		hint?.remove();
		tab_list.removeAttribute("aria-keyshortcuts");
		return;
	}

	tab_list.setAttribute("aria-keyshortcuts", "Alt+M");
	if (!hint) {
		const instructions = document.createElement("span");
		instructions.className = TAB_HINT_CLASS;
		instructions.textContent = tabs.length > 1
			? "Alt+M\u00a0 ← →\u00a0 · \u00a0Alt+D Enter"
			: "Alt+M\u00a0 · \u00a0Alt+D Enter";
		instructions.title = __("Press Alt+M to select tabs, Left or Right to switch, and Alt+D to enter the active tab");
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
		let hint = node.querySelector(`:scope > .${class_name}`);
		if (!hint) {
			hint = document.createElement("span");
			hint.className = class_name;
			node.append(hint);
		}
		hint.textContent = shortcut;
		hint.title = help;
	}
}

export function decorate_form_hints(frm, wrapper, tabs, section_head, selected_section) {
	decorate_tab_hint(frm, tabs);
	decorate_hints(
		wrapper, new Set(section_head ? [section_head] : []),
		"section", selected_section ? "Alt+H ↑ ↓ · Alt+D Enter" : "Alt+H ↑ ↓",
		__("Press Alt+H and Up or Down to select a heading, then Alt+D to enter it")
	);
}
