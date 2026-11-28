import {
	focus_field_before_heading, focus_first_field, handle_field_keys, reset_field_navigation,
} from "./fields.js";
import { decorate_form_hints } from "./form_hints.js";
import { focus_grid_from_target } from "./grid.js";
import {
	enhance_form_sections, first_visible_grid_target, get_section_group, is_section_available,
	is_section_collapsed, set_section_collapsed,
} from "./section_groups.js";
import {
	consume_key, has_open_autocomplete, is_alt_key, is_dialog_open, is_editable_element, is_visible,
} from "./shared.js";

const SECTION_CLASS = "srv-erp-form-section-keyboard-active";
let keyboard_tab = null;
let tab_focus = null;
let keyboard_section = null;

function get_form_wrapper(frm) {
	return frm?.wrapper?.get?.(0) || frm?.wrapper;
}

function get_visible_form() {
	const frm = window.cur_frm;
	return is_visible(get_form_wrapper(frm)) ? frm : null;
}

function get_tabs(frm) {
	return (frm.layout?.tabs || []).filter((tab) =>
		!tab.hidden && !tab.is_hidden?.() && is_visible(tab.tab_link?.get?.(0))
	);
}

function get_active_tab(frm, tabs) {
	const active = frm.get_active_tab?.();
	return tabs.includes(active) ? active : tabs.find((tab) => tab.is_active()) || tabs[0];
}

function get_section_head(section) {
	return section?.head?.get?.(0);
}

function get_section_tab(section, tabs) {
	const pane = section.wrapper?.get?.(0)?.closest(".tab-pane");
	return tabs.find((tab) => tab.wrapper?.get?.(0) === pane);
}

function get_sections(frm, tabs) {
	enhance_form_sections(frm);
	const tabbed = Boolean(frm.layout?.tabs?.length);
	return (frm.layout?.sections || []).filter((section) => {
		const wrapper = section.wrapper?.get?.(0);
		const has_content = get_section_group(section).some((member) =>
			member.df?.body_html || member.fields_list?.some((field) => field.disp_status !== "None")
		);
		if (!get_section_head(section) || !has_content || !wrapper || !is_section_available(section)) {
			return false;
		}
		return !tabbed || !wrapper.closest(".tab-pane") || Boolean(get_section_tab(section, tabs));
	});
}

function focus_section_content(frm, section, tabs) {
	const grid_target = first_visible_grid_target(section);
	if (grid_target && focus_grid_from_target(grid_target)) {
		return grid_target;
	}

	const tab = get_section_tab(section, tabs);
	for (const member of get_section_group(section)) {
		const input = focus_first_field(frm, get_section_tab(member, tabs) || tab, member);
		if (input) {
			return input;
		}
	}
	return null;
}

function starting_section(frm, tabs, sections) {
	const active = get_active_tab(frm, tabs);
	const current_sections = sections.filter((section) => get_section_tab(section, tabs) === active);
	const focused = current_sections.find((section) => get_section_group(section).some(
		(member) => member.wrapper?.get?.(0)?.contains(document.activeElement)
	));
	return focused || current_sections[0];
}

export function decorate_current_form() {
	const frm = get_visible_form();
	if (!frm) {
		return;
	}
	const tabs = get_tabs(frm);
	const sections = get_sections(frm, tabs);
	const section = sections.includes(keyboard_section) ? keyboard_section : null;
	const head = get_section_head(section || starting_section(frm, tabs, sections));
	decorate_form_hints(frm, get_form_wrapper(frm), tabs, head, section);
}

function clear_tab_navigation() {
	keyboard_tab = null;
	tab_focus = null;
}

function clear_section_navigation() {
	get_section_head(keyboard_section)?.classList.remove(SECTION_CLASS);
	keyboard_section = null;
}

export function reset_form_navigation() {
	clear_tab_navigation();
	clear_section_navigation();
	reset_field_navigation();
}

function activate_tab(tab, after_show) {
	if (!tab || tab.is_active()) {
		after_show();
		return;
	}
	const link = tab.tab_link.find(".nav-link");
	link.one("shown.bs.tab", after_show);
	tab.set_active();
}

function select_tab(frm, tab) {
	keyboard_tab = tab;
	const button = tab.tab_link.find(".nav-link").get(0);
	activate_tab(tab, () => {
		if (keyboard_tab !== tab || get_visible_form() !== frm) {
			return;
		}
		tab_focus = button;
		button?.focus({ preventScroll: true });
		button?.scrollIntoView({ block: "nearest", inline: "nearest" });
		decorate_current_form();
	});
}

function select_section(frm, section, tabs, sections) {
	const previous = keyboard_section;
	const tab = get_section_tab(section, tabs);
	if (previous?.df?.collapsible && previous !== section && !is_section_collapsed(previous)) {
		set_section_collapsed(previous, true);
	}
	clear_section_navigation();
	reset_field_navigation();
	keyboard_section = section;
	activate_tab(tab, () => {
		if (keyboard_section !== section || get_visible_form() !== frm) {
			return;
		}
		for (const other of sections) {
			if (other !== section && other.df?.collapsible &&
				get_section_tab(other, tabs) === tab && !is_section_collapsed(other)) {
				set_section_collapsed(other, true);
			}
		}
		if (section.df?.collapsible && is_section_collapsed(section)) {
			set_section_collapsed(section, false);
		}
		const head = get_section_head(section);
		if (!head.hasAttribute("tabindex")) {
			head.setAttribute("tabindex", "-1");
		}
		head.classList.add(SECTION_CLASS);
		head.focus({ preventScroll: true });
		head.scrollIntoView({ block: "center", inline: "nearest" });
		decorate_current_form();
	});
}

function move_selection(items, selection, step) {
	const index = items.indexOf(selection);
	return index < 0 ? items[0] : items[(index + step + items.length) % items.length];
}

function handle_tab_keys(event, frm, tabs) {
	if (!keyboard_tab || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return false;
	}
	if (event.key === "Escape") {
		consume_key(event);
		clear_tab_navigation();
		reset_field_navigation();
		return true;
	}
	if (["ArrowLeft", "ArrowRight"].includes(event.key) && tabs.length &&
		(event.target === tab_focus || !is_editable_element(event.target))) {
		consume_key(event);
		select_tab(frm, move_selection(tabs, keyboard_tab, event.key === "ArrowRight" ? 1 : -1));
		return true;
	}
	clear_tab_navigation();
	if (event.key === "Tab") {
		reset_field_navigation();
	}
	return false;
}

function handle_section_keys(event, frm, tabs) {
	if (!keyboard_section || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
		return false;
	}
	if (event.key === "Escape") {
		consume_key(event);
		clear_section_navigation();
		decorate_current_form();
		return true;
	}
	if (is_editable_element(event.target) || event.key === "Tab") {
		clear_section_navigation();
		decorate_current_form();
		return false;
	}
	if (!["ArrowDown", "ArrowUp"].includes(event.key)) {
		return false;
	}
	const all_sections = get_sections(frm, tabs);
	const selected_tab = get_section_tab(keyboard_section, tabs) || get_active_tab(frm, tabs);
	const sections = all_sections.filter((section) => get_section_tab(section, tabs) === selected_tab);
	if (!sections.includes(keyboard_section)) {
		clear_section_navigation();
		return false;
	}
	consume_key(event);
	const current_index = sections.indexOf(keyboard_section);
	const entering_details =
		(event.key === "ArrowUp" && current_index === 0) ||
		(event.key === "ArrowDown" && current_index === sections.length - 1);
	if (entering_details) {
		const current = keyboard_section;
		const first_heading = get_section_head(sections[0]);
		if (current.df?.collapsible && !is_section_collapsed(current)) {
			set_section_collapsed(current, true);
		}
		clear_section_navigation();
		const input = focus_field_before_heading(
			frm, selected_tab, first_heading, event.key === "ArrowUp"
		);
		if (input) {
			decorate_current_form();
			return true;
		}
		keyboard_section = current;
	}
	const next = move_selection(sections, keyboard_section, event.key === "ArrowDown" ? 1 : -1);
	select_section(frm, next, tabs, sections);
	return true;
}

function sections_in_active_tab(frm, tabs) {
	const active = get_active_tab(frm, tabs);
	return get_sections(frm, tabs).filter((section) => get_section_tab(section, tabs) === active);
}

function select_heading(frm, tabs, heading) {
	const sections = sections_in_active_tab(frm, tabs);
	const section = sections.find((candidate) => get_section_head(candidate) === heading);
	if (!section) {
		return false;
	}
	select_section(frm, section, tabs, sections);
	return true;
}

export function return_to_parent_heading(event) {
	if (event.key !== "Escape" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
		is_dialog_open() || has_open_autocomplete(event.target) ||
		!event.target.closest?.(".srv-erp-form-field-keyboard, .srv-erp-grid-keyboard-cell") ||
		event.target.closest?.(".section-head")) {
		return false;
	}

	const frm = get_visible_form();
	const child_wrapper = event.target.closest?.(".form-section, .form-dashboard-section");
	if (!frm || !child_wrapper) {
		return false;
	}

	const tabs = get_tabs(frm);
	const sections = sections_in_active_tab(frm, tabs);
	const parent = sections.find((section) => get_section_group(section).some(
		(member) => member.wrapper?.get?.(0) === child_wrapper
	));
	if (!parent) {
		return false;
	}

	consume_key(event);
	if (!event.repeat) {
		select_section(frm, parent, tabs, sections);
	}
	return true;
}

function handle_direct_section_arrow(event, frm, tabs) {
	if (keyboard_section || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
		!["ArrowDown", "ArrowUp"].includes(event.key)) {
		return false;
	}
	const heading = event.target.closest?.(".section-head.collapsible");
	if (!heading) {
		return false;
	}
	const sections = sections_in_active_tab(frm, tabs);
	const current = sections.find((section) => get_section_head(section) === heading);
	if (!current) {
		return false;
	}
	consume_key(event);
	const next = move_selection(sections, current, event.key === "ArrowDown" ? 1 : -1);
	select_section(frm, next, tabs, sections);
	return true;
}

function start_form_navigation(frm, active_tab) {
	reset_form_navigation();
	if (active_tab) {
		select_tab(frm, active_tab);
	} else {
		focus_first_field(frm, null);
	}
}

export function handle_form_keyboard(event) {
	if (event.isComposing || is_dialog_open()) {
		return;
	}
	const frm = get_visible_form();
	if (!frm) {
		return;
	}
	const tabs = get_tabs(frm);
	const active_tab = get_active_tab(frm, tabs);

	if (is_alt_key(event, "KeyM")) {
		consume_key(event);
		if (!event.repeat) {
			start_form_navigation(frm, active_tab);
		}
		return;
	}
	if (is_alt_key(event, "KeyH")) {
		const sections = get_sections(frm, tabs);
		const section = starting_section(frm, tabs, sections);
		if (section) {
			consume_key(event);
			if (!event.repeat) {
				reset_form_navigation();
				select_section(frm, section, tabs, sections);
			}
		}
		return;
	}
	if (is_alt_key(event, "KeyD")) {
		if (event.repeat) {
			return;
		}
		const sections = get_sections(frm, tabs);
		const focused_section = event.target.closest?.(".form-section, .form-dashboard-section");
		const heading = keyboard_section || sections.find((section) => section.wrapper?.get?.(0) === focused_section);
		if (heading?.df?.collapsible && is_section_collapsed(heading)) {
			set_section_collapsed(heading, false);
		}
		const input = heading
			? focus_section_content(frm, heading, tabs)
			: focus_first_field(frm, active_tab);
		if (input) {
			consume_key(event);
			clear_tab_navigation();
			clear_section_navigation();
			if (focus_grid_from_target(input)) {
				reset_field_navigation();
			}
			decorate_current_form();
		}
		return;
	}
	if (handle_tab_keys(event, frm, tabs) || handle_section_keys(event, frm, tabs) ||
		handle_direct_section_arrow(event, frm, tabs)) {
		return;
	}
	handle_field_keys(event, frm, active_tab, (heading) => select_heading(frm, tabs, heading));
}
