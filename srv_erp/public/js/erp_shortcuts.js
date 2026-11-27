import {
	clear_sidebar_keyboard_selection, decorate_home_shortcuts, decorate_user_menu_hint, focus_home_sidebar_item, handle_escape_navigation,
	handle_sidebar_keyboard, handle_user_menu_shortcut, register_page_shortcuts, register_profile_shortcut,
} from "./erp_shortcuts/desk.js";
import { decorate_current_form, handle_form_keyboard, reset_form_navigation } from "./erp_shortcuts/form.js";
import { get_active_grid, handle_grid_keyboard, register_grid_settings_shortcut, reset_grid_navigation, track_grid_pointer } from "./erp_shortcuts/grid.js";
import { decorate_grid_hints } from "./erp_shortcuts/grid_hints.js";
import { bind_grid_settings_events } from "./erp_shortcuts/grid_surfaces.js";
import {
	decorate_list_filter_shortcuts, decorate_list_primary_action_shortcut, handle_list_filter_keyboard,
	handle_list_primary_action_keyboard, schedule_route_search_cleanup,
} from "./erp_shortcuts/list.js";
import { handle_page_keyboard, reset_page_navigation } from "./erp_shortcuts/page_navigation.js";
import { add_item_to_sales_order, create_item } from "./erp_shortcuts/quick_entry.js";
import { consume_key, is_alt_key, is_dialog_open } from "./erp_shortcuts/shared.js";
import { inject_shortcut_styles } from "./erp_shortcuts/styles.js";

let decoration_frame = null;

function schedule_decoration() {
	if (decoration_frame !== null) {
		return;
	}
	decoration_frame = window.requestAnimationFrame(() => {
		decoration_frame = null;
		decorate_home_shortcuts();
		decorate_user_menu_hint();
		decorate_grid_hints(get_active_grid(document.activeElement));
		decorate_list_filter_shortcuts();
		decorate_list_primary_action_shortcut();
		decorate_current_form();
	});
}

function handle_keyboard(event) {
	if (event.defaultPrevented || event.isComposing) {
		return;
	}
	const form_tab_shortcut = is_alt_key(event, "KeyM");
	if (form_tab_shortcut) {
		handle_form_keyboard(event);
		if (event.defaultPrevented) {
			return;
		}
	}
	if (handle_grid_keyboard(event)) {
		return;
	}
	if (!form_tab_shortcut) {
		handle_form_keyboard(event);
	}
	if (event.defaultPrevented || handle_page_keyboard(event)) {
		return;
	}
	if (is_alt_key(event, "KeyM") && !is_dialog_open()) {
		consume_key(event);
		if (!event.repeat) {
			clear_sidebar_keyboard_selection();
			focus_home_sidebar_item();
		}
		return;
	}
	for (const handle of [
		handle_list_primary_action_keyboard, handle_list_filter_keyboard, handle_sidebar_keyboard, handle_escape_navigation,
	]) {
		handle(event);
		if (event.defaultPrevented) {
			return;
		}
	}
}

function register_shortcuts() {
	if (window.__srv_erp_shortcuts_registered || !window.frappe?.ui?.keys?.add_shortcut || !document.body) {
		return false;
	}

	register_page_shortcuts();
	window.addEventListener("keydown", handle_user_menu_shortcut, true);
	register_profile_shortcut();
	register_grid_settings_shortcut();
	inject_shortcut_styles();
	schedule_decoration();
	new MutationObserver(schedule_decoration).observe(document.body, { childList: true, subtree: true });
	document.addEventListener("keydown", handle_keyboard, true);
	document.addEventListener("focusin", schedule_decoration);
	bind_grid_settings_events();
	document.addEventListener("pointerdown", (event) => {
		reset_form_navigation();
		track_grid_pointer(event);
		reset_page_navigation();
		schedule_decoration();
	}, true);
	frappe.router?.on?.("change", () => {
		reset_form_navigation();
		reset_grid_navigation();
		reset_page_navigation();
		clear_sidebar_keyboard_selection();
		schedule_route_search_cleanup();
		schedule_decoration();
	});
	schedule_route_search_cleanup();
	window.__srv_erp_shortcuts_registered = true;
	return true;
}

// Sales Order calls create_item through this existing Desk API.
window.srv_erp_shortcuts = { add_item_to_sales_order, create_item, register_shortcuts };

if (!register_shortcuts()) {
	let attempts = 0;
	const timer = window.setInterval(() => {
		attempts += 1;
		if (register_shortcuts() || attempts >= 50) {
			window.clearInterval(timer);
		}
	}, 200);
}
