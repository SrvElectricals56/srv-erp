import { get_desk_grids } from "./grid.js";
import { is_visible } from "./shared.js";

let highlighted_grid = null;
const HINT_CLASS = "srv-erp-grid-shortcut-hint";
const ACTIVE_CLASS = "srv-erp-grid-shortcuts-active";

function place_hint(target, text, title, icon = false) {
	if (!target || target.querySelector(`:scope > .${HINT_CLASS}`)) {
		return;
	}
	const hint = document.createElement("span");
	hint.className = HINT_CLASS;
	hint.textContent = text;
	hint.title = title;
	target.setAttribute("aria-keyshortcuts", text.split(" ")[0]);
	if (icon) {
		target.classList.add("srv-erp-grid-icon-shortcut");
		hint.setAttribute("aria-hidden", "true");
	}
	target.append(hint);
}

export function decorate_grid_hints(active_grid) {
	const root = active_grid?.wrapper?.get?.(0);
	if (highlighted_grid !== root) {
		highlighted_grid?.classList.remove(ACTIVE_CLASS);
		root?.classList.add(ACTIVE_CLASS);
		highlighted_grid = root;
	}

	for (const grid of get_desk_grids()) {
		const wrapper = grid.wrapper?.get?.(0);
		if (!is_visible(wrapper)) {
			continue;
		}
		const label = wrapper.querySelector(":scope > label.control-label");
		label?.querySelector(`:scope > .${HINT_CLASS}`)?.remove();
		if (label?.getAttribute("aria-keyshortcuts") === "Alt+M") {
			label.removeAttribute("aria-keyshortcuts");
		}
		for (const row of grid.grid_rows || []) {
			place_hint(row?.open_form_button?.get?.(0)?.closest(".btn-open-row"), "Alt+E", __("Edit row (Alt+E)"), true);
		}
		const gear = grid.header_row?.configure_columns_button?.get?.(0);
		if (gear?.querySelector("a")) {
			place_hint(gear, "Alt+S", __("Configure Columns (Alt+S)"), true);
		}
	}
}
