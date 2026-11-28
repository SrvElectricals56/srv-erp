import { consume_key } from "./shared.js";

const DIALOG_CLASS = "srv-erp-unsaved-dialog";
let active_dialog = null;
let dialog_busy = false;

function go_back_one_step() {
	window.requestAnimationFrame(() => {
		if (window.history.length > 1) {
			window.history.back();
		}
	});
}

function action_buttons(dialog) {
	return [
		dialog.get_secondary_btn?.().get?.(0),
		dialog.get_primary_btn?.().get?.(0),
	].filter((button) => button && !button.disabled && !button.classList.contains("disabled"));
}

function focus_action(dialog, button) {
	const target = button || action_buttons(dialog).at(-1);
	target?.focus({ preventScroll: true });
}

function set_busy(dialog, busy) {
	dialog_busy = busy;
	for (const button of [
		dialog.get_secondary_btn?.().get?.(0),
		dialog.get_primary_btn?.().get?.(0),
	]) {
		if (button) {
			button.disabled = busy;
		}
	}
}

function bind_action_keyboard(dialog) {
	const wrapper = dialog.$wrapper?.get?.(0);
	if (!wrapper) {
		return;
	}
	wrapper.classList.add(DIALOG_CLASS);
	wrapper.addEventListener("keydown", (event) => {
		if (dialog_busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
			return;
		}
		const buttons = action_buttons(dialog);
		if (!buttons.length) {
			return;
		}
		if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
			consume_key(event);
			const index = Math.max(buttons.indexOf(document.activeElement), 0);
			const step = event.key === "ArrowRight" ? 1 : -1;
			focus_action(dialog, buttons[(index + step + buttons.length) % buttons.length]);
			return;
		}
		if (event.key === "Enter" && buttons.includes(document.activeElement)) {
			consume_key(event);
			if (!event.repeat) {
				document.activeElement.click();
			}
		}
	}, true);
}

async function save_and_leave(frm, dialog) {
	if (dialog_busy) {
		return;
	}
	set_busy(dialog, true);
	const save_action = frm.doc?.docstatus === 1 ? "Update" : undefined;
	try {
		await frm.save(save_action, undefined, dialog.get_primary_btn?.().get?.(0), () => {});
		if (!frm.is_dirty?.()) {
			dialog.hide();
			go_back_one_step();
			return;
		}
	} finally {
		if (active_dialog === dialog) {
			set_busy(dialog, false);
			focus_action(dialog);
		}
	}
}

function discard_and_leave(frm, dialog) {
	if (dialog_busy) {
		return;
	}
	frappe.model.remove_from_locals(frm.doctype, frm.docname);
	dialog.hide();
	go_back_one_step();
}

export function show_unsaved_navigation_dialog(frm) {
	if (active_dialog?.$wrapper?.is?.(":visible")) {
		focus_action(active_dialog);
		return active_dialog;
	}

	const dialog = new frappe.ui.Dialog({
		title: __("Unsaved Changes"),
		size: "small",
		static: true,
		fields: [{
			fieldtype: "HTML",
			options: `<p class="mb-0">${__("Save your changes before leaving this page, or discard them and go back.")}</p>`,
		}],
	});
	dialog.set_secondary_action_label(__("Discard"));
	dialog.set_secondary_action(() => discard_and_leave(frm, dialog));
	dialog.set_primary_action(__("Save"), () => void save_and_leave(frm, dialog));
	dialog.on_hide = () => {
		if (active_dialog === dialog) {
			active_dialog = null;
			dialog_busy = false;
		}
	};
	bind_action_keyboard(dialog);
	dialog.show();
	window.requestAnimationFrame(() => focus_action(dialog));
	active_dialog = dialog;
	return dialog;
}
