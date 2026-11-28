const VISIBLE_CLASS = "srv-erp-keyboard-labels-visible";
const STATE_ATTRIBUTE = "data-srv-erp-keyboard-labels";
const PHONE_SHORT_EDGE_MAX_PX = 767;
const HARDWARE_CODE = /^(Key|Digit|Numpad|Arrow|F\d|Escape|Tab|Enter|Space|Backspace|Delete|Insert|Home|End|Page|CapsLock|Shift|Control|Alt|Meta|ContextMenu|Bracket|Semicolon|Quote|Comma|Period|Slash|Backslash|Minus|Equal|Intl)/;

let initialized = false;
let hardware_input_mode = false;

function touch_capable() {
	return Number(navigator.maxTouchPoints || 0) > 0 || window.matchMedia("(any-pointer: coarse)").matches;
}

function phone_sized_touch_environment() {
	const short_edge = Math.min(
		Number(window.innerWidth || Number.POSITIVE_INFINITY),
		Number(window.innerHeight || Number.POSITIVE_INFINITY)
	);
	return touch_capable() && short_edge <= PHONE_SHORT_EDGE_MAX_PX;
}

function desktop_input_environment() {
	return !touch_capable() && window.matchMedia("(any-hover: hover) and (any-pointer: fine)").matches;
}

function set_labels_visible(visible) {
	// A phone must never expose keyboard hints, even when its virtual keyboard
	// produces a keydown event that resembles a physical keyboard event.
	visible = Boolean(visible && !phone_sized_touch_environment());
	const root = document.documentElement;
	if (root.classList.contains(VISIBLE_CLASS) === visible &&
		root.getAttribute(STATE_ATTRIBUTE) === (visible ? "visible" : "hidden")) {
		return;
	}
	root.classList.toggle(VISIBLE_CLASS, visible);
	root.setAttribute(STATE_ATTRIBUTE, visible ? "visible" : "hidden");
	window.dispatchEvent(new CustomEvent("srv-erp-keyboard-labels-change", { detail: { visible } }));
}

function is_hardware_keyboard_event(event) {
	return event.isTrusted && !event.isComposing && event.key !== "Unidentified" &&
		Boolean(event.code && event.code !== "Unidentified" && HARDWARE_CODE.test(event.code));
}

function record_hardware_keyboard(event) {
	if (!is_hardware_keyboard_event(event)) {
		return;
	}
	if (phone_sized_touch_environment()) {
		hardware_input_mode = false;
		set_labels_visible(false);
		return;
	}
	hardware_input_mode = true;
	set_labels_visible(true);
}

function record_touch_input(event) {
	if (event.pointerType !== "touch") {
		return;
	}
	hardware_input_mode = false;
	set_labels_visible(false);
}

function refresh_capability_state() {
	if (phone_sized_touch_environment()) {
		hardware_input_mode = false;
		set_labels_visible(false);
		return;
	}
	if (desktop_input_environment()) {
		set_labels_visible(true);
		return;
	}
	set_labels_visible(hardware_input_mode);
}

export function initialize_keyboard_label_visibility() {
	if (initialized) {
		return;
	}
	initialized = true;
	refresh_capability_state();
	document.addEventListener("keydown", record_hardware_keyboard, true);
	document.addEventListener("pointerdown", record_touch_input, true);
	for (const query of ["(any-hover: hover)", "(any-pointer: fine)", "(any-pointer: coarse)"]) {
		window.matchMedia(query).addEventListener?.("change", refresh_capability_state);
	}
	window.addEventListener("resize", refresh_capability_state, { passive: true });
	window.addEventListener("orientationchange", refresh_capability_state, { passive: true });
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) {
			refresh_capability_state();
		}
	});
}

export function keyboard_labels_visible() {
	return document.documentElement.classList.contains(VISIBLE_CLASS);
}
