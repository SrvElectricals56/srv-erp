(function setup_srv_erp_dialog_keyboard() {
	"use strict";

	if (window.srv_erp_dialog_keyboard) {
		return;
	}

	const ACTIVE_CLASS = "srv-erp-dialog-keyboard-active";
	const CONTROL_SELECTOR = [
		'input:not([type="hidden"])', "select", "textarea", '[contenteditable="true"]',
		'button:not(:disabled)', 'a[href]', '[role="button"]', '[role="checkbox"]', '[role="switch"]',
		".add-new-fields", ".remove-field",
	].join(", ");
	const ACTION_SELECTOR = [
		"button", "a[href]", '[role="button"]', '[role="checkbox"]', '[role="switch"]',
		'input[type="checkbox"]', 'input[type="radio"]', ".add-new-fields", ".remove-field",
	].join(", ");
	const SPECIALIZED_GRID = ".grid-field, .grid-row, .grid-form, .grid-dialog";
	const COLUMN_SETTINGS_SURFACE = ".selected-fields, .add-new-fields";
	const PICKER_SURFACE = ".unit-checkbox";
	let typing_target = null;

	function visible(element) {
		return Boolean(element?.getClientRects?.().length);
	}

	function popover_open(element) {
		try {
			return element.matches(":popover-open");
		} catch (_error) {
			return false;
		}
	}

	function active_surface() {
		const surfaces = [
			...document.querySelectorAll(".modal.show, dialog[open], [popover]"),
		].filter((surface) => visible(surface) &&
			(!surface.hasAttribute("popover") || popover_open(surface)));
		return surfaces.at(-1) || null;
	}

	function enabled(element) {
		return Boolean(element && visible(element) &&
			!element.matches(":disabled, [disabled], [readonly], [aria-disabled=true], .disabled"));
	}

	function primary_action(surface) {
		if (!surface) {
			return null;
		}
		const selector = surface.matches(".modal.show")
			? ".modal-footer .btn-modal-primary"
			: [
				'button.primary[type="submit"]', 'button[type="submit"]', ".btn-primary",
				"button.primary", "[data-confirm-save]", "[data-confirm]", "[data-save]",
			].join(", ");
		return [...surface.querySelectorAll(selector)].find(enabled) || null;
	}

	function explicit_close(surface) {
		if (!surface) {
			return null;
		}
		const selector = surface.matches(".modal.show")
			? ".modal-header .btn-modal-close"
			: [
				"[data-cancel-save]", "[data-cancel]", "[data-close]", "[data-dismiss]",
				"[data-cancel-vehicle]", '[aria-label^="Close"]', '[aria-label^="Cancel"]',
			].join(", ");
		return [...surface.querySelectorAll(selector)].find(enabled) || null;
	}

	function close_surface(surface) {
		const close = explicit_close(surface);
		if (close) {
			close.click();
			return true;
		}
		if (surface?.matches("dialog[open]")) {
			surface.close();
			return true;
		}
		if (surface?.hasAttribute("popover") && popover_open(surface)) {
			surface.hidePopover?.();
			return true;
		}
		return false;
	}

	function open_autocomplete(target) {
		const list = target?.closest?.(".awesomplete")?.querySelector("ul");
		return Boolean(list && visible(list) && !list.hasAttribute("hidden"));
	}

	function surface_controls(surface) {
		if (!surface) {
			return [];
		}
		const controls = [...new Set([...surface.querySelectorAll(CONTROL_SELECTOR)])].filter((control) =>
			enabled(control) &&
			!control.closest(".hide, .hidden, [hidden], .modal-header, .ql-toolbar, .awesomplete > ul, .datepicker, .dropdown-menu")
		);
		for (const control of controls) {
			if (control.matches(".add-new-fields, .remove-field")) {
				control.setAttribute("role", "button");
				control.setAttribute("tabindex", "0");
			}
		}
		return controls;
	}

	function current_control(target, controls) {
		return controls.find((control) => control === target || control.contains(target)) || null;
	}

	function clear_active(surface = document) {
		for (const control of surface.querySelectorAll(`.${ACTIVE_CLASS}`)) {
			control.classList.remove(ACTIVE_CLASS);
		}
	}

	function focus_control(control, surface) {
		if (!control) {
			return false;
		}
		clear_active(surface);
		control.classList.add(ACTIVE_CLASS);
		if (control.tabIndex < 0 && !control.hasAttribute("tabindex")) {
			control.setAttribute("tabindex", "-1");
		}
		control.focus({ preventScroll: true });
		control.scrollIntoView({ block: "nearest", inline: "nearest" });
		if (control.matches('input[type="text"], input[type="search"], textarea')) {
			control.select();
		}
		typing_target = null;
		return true;
	}

	function center(control) {
		const rect = control.getBoundingClientRect();
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}

	function directional_control(controls, current, key) {
		if (!current) {
			return ["ArrowUp", "ArrowLeft"].includes(key) ? controls.at(-1) : controls[0];
		}
		const origin = center(current);
		const vertical = key === "ArrowUp" || key === "ArrowDown";
		const positive = key === "ArrowDown" || key === "ArrowRight";
		const candidates = controls.filter((control) => {
			if (control === current) {
				return false;
			}
			const point = center(control);
			const delta = vertical ? point.y - origin.y : point.x - origin.x;
			return positive ? delta > 2 : delta < -2;
		});
		candidates.sort((left, right) => {
			const score = (control) => {
				const point = center(control);
				const primary = Math.abs((vertical ? point.y : point.x) - (vertical ? origin.y : origin.x));
				const cross = Math.abs((vertical ? point.x : point.y) - (vertical ? origin.x : origin.y));
				return primary + cross * 1.75;
			};
			return score(left) - score(right);
		});
		if (candidates[0]) {
			return candidates[0];
		}
		const index = controls.indexOf(current);
		const step = positive ? 1 : -1;
		return controls[(index + step + controls.length) % controls.length];
	}

	function ordered_control(controls, current, key) {
		if (!current) {
			return ["ArrowUp", "ArrowLeft"].includes(key) ? controls.at(-1) : controls[0];
		}
		const index = controls.indexOf(current);
		const step = ["ArrowUp", "ArrowLeft"].includes(key) ? -1 : 1;
		return controls[(index + step + controls.length) % controls.length];
	}

	function column_settings_model(surface) {
		if (!surface.querySelector(COLUMN_SETTINGS_SURFACE)) {
			return null;
		}
		const rows = [...surface.querySelectorAll(".selected-fields .fields_order")].filter(visible);
		const widths = rows.map((row) => row.querySelector(".column-width")).filter(enabled);
		const removes = rows.map((row) => row.querySelector(".remove-field")).filter(enabled);
		const add = surface.querySelector(".add-new-fields");
		const footer = [...surface.querySelectorAll(".modal-footer button")].filter(enabled);
		for (const action of [...removes, add].filter(Boolean)) {
			action.setAttribute("role", "button");
			action.setAttribute("tabindex", "0");
		}
		return {
			add: enabled(add) ? add : null,
			all: [...widths, ...removes, ...(enabled(add) ? [add] : []), ...footer],
			footer,
			removes,
			widths,
		};
	}

	function column_settings_target(model, current, key) {
		const { add, footer, removes, widths } = model;
		if (!current) {
			return widths[0] || add || footer[0] || null;
		}

		const vertical = key === "ArrowUp" || key === "ArrowDown";
		const forward = key === "ArrowDown" || key === "ArrowRight";
		const width_index = widths.indexOf(current);
		const remove_index = removes.indexOf(current);
		const footer_index = footer.indexOf(current);
		if (vertical && width_index >= 0) {
			return widths[width_index + (forward ? 1 : -1)] ||
				(forward ? add || footer[0] : footer.at(-1) || add || widths.at(-1));
		}
		if (vertical && remove_index >= 0) {
			return removes[remove_index + (forward ? 1 : -1)] ||
				(forward ? add || footer[0] : footer.at(-1) || add || removes.at(-1));
		}
		if (current === add) {
			return forward ? footer[0] || widths[0] : widths.at(-1) || footer.at(-1);
		}
		if (footer_index >= 0) {
			return footer[footer_index + (forward ? 1 : -1)] ||
				(forward ? widths[0] || add : add || widths.at(-1));
		}
		if (width_index >= 0) {
			return forward ? removes[width_index] || widths[width_index + 1] || add :
				widths[width_index - 1] || footer.at(-1) || add;
		}
		if (remove_index >= 0) {
			return forward ? widths[remove_index + 1] || add || footer[0] : widths[remove_index];
		}
		return widths[0] || add || footer[0] || null;
	}

	function handle_column_settings(event, surface) {
		const model = column_settings_model(surface);
		if (!model) {
			return false;
		}
		const current = current_control(event.target, model.all);
		if (!current && event.target !== surface && event.target !== document.body) {
			return false;
		}
		if (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key)) {
			typing_target = current;
			return false;
		}
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key) ||
			open_autocomplete(event.target)) {
			return false;
		}
		if (event.key === "Enter") {
			consume(event);
			if (!event.repeat && current?.matches(ACTION_SELECTOR)) {
				current.click();
			} else if (!event.repeat) {
				focus_control(column_settings_target(model, current, "ArrowDown"), surface);
			}
			return true;
		}
		if (keep_field_arrow(event, current)) {
			return false;
		}
		consume(event);
		return focus_control(column_settings_target(model, current, event.key), surface);
	}

	function keep_field_arrow(event, control) {
		if (typing_target !== control) {
			return false;
		}
		if (control.matches('textarea, [contenteditable="true"]')) {
			return true;
		}
		return ["ArrowLeft", "ArrowRight"].includes(event.key) &&
			control.matches('input:not([type="checkbox"]):not([type="radio"])');
	}

	function consume(event) {
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	function handle(event) {
		const surface = active_surface();
		if (!surface || event.isComposing) {
			return false;
		}
		if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
			(event.code === "KeyO" || event.key?.toLowerCase() === "o")) {
			const primary = primary_action(surface);
			if (!primary) {
				return false;
			}
			consume(event);
			if (!event.repeat) {
				primary.click();
			}
			return true;
		}
		if (event.key === "Escape" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
			if (open_autocomplete(event.target)) {
				return false;
			}
			if (close_surface(surface)) {
				consume(event);
				return true;
			}
			return false;
		}
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
			event.target.closest?.(SPECIALIZED_GRID)) {
			return false;
		}
		if (handle_column_settings(event, surface)) {
			return true;
		}
		const controls = surface_controls(surface);
		const current = current_control(event.target, controls);
		if (event.key.length === 1 || ["Backspace", "Delete"].includes(event.key)) {
			typing_target = current;
			return false;
		}
		if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key) ||
			open_autocomplete(event.target)) {
			return false;
		}
		if (event.key === "Enter") {
			if (!current?.matches(ACTION_SELECTOR) || current.matches('textarea, [contenteditable="true"]')) {
				return false;
			}
			consume(event);
			if (!event.repeat) {
				current.click();
			}
			return true;
		}
		if (keep_field_arrow(event, current)) {
			return false;
		}
		consume(event);
		const next = surface.querySelector(PICKER_SURFACE)
			? ordered_control(controls, current, event.key)
			: directional_control(controls, current, event.key);
		return focus_control(next, surface);
	}

	function decorate() {
		const surface = active_surface();
		if (!surface) {
			typing_target = null;
			clear_active();
			return;
		}
		surface.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight Alt+O Escape");
		primary_action(surface)?.setAttribute("aria-keyshortcuts", "Alt+O");
		explicit_close(surface)?.setAttribute("aria-keyshortcuts", "Escape");
		const active = document.activeElement;
		if (active && surface.contains(active) && surface_controls(surface).includes(active)) {
			clear_active(surface);
			active.classList.add(ACTIVE_CLASS);
		}
	}

	function install_focus_style() {
		if (document.getElementById("srv-erp-dialog-keyboard-core-style")) {
			return;
		}
		const style = document.createElement("style");
		style.id = "srv-erp-dialog-keyboard-core-style";
		style.textContent = `
			.srv-erp-dialog-keyboard-active:focus {
				outline: 2px solid var(--gray-500, #718096) !important;
				outline-offset: 2px;
				border-radius: var(--border-radius, 6px);
			}
		`;
		document.head.appendChild(style);
	}

	window.srv_erp_dialog_keyboard = {
		active_surface, close_surface, decorate, handle, primary_action, surface_controls,
	};
	document.addEventListener("keydown", handle, true);
	document.addEventListener("focusin", decorate, true);
	new MutationObserver(decorate).observe(document.documentElement, { childList: true, subtree: true });
	install_focus_style();
	decorate();
})();
