export function is_dialog_open() {
	return Boolean(document.querySelector(".modal.show"));
}

export function is_visible(element) {
	return Boolean(element?.getClientRects().length);
}

export function get_visible_page_container() {
	return [...document.querySelectorAll(".page-container")].find(is_visible) || document;
}

export function is_editable_element(element) {
	return Boolean(element?.matches?.("input, select, textarea, [contenteditable=true]"));
}

export function has_open_autocomplete(input) {
	const suggestions = input?.closest?.(".awesomplete")?.querySelector("ul");
	return Boolean(suggestions && is_visible(suggestions) && !suggestions.hasAttribute("hidden"));
}

export function is_alt_key(event, code) {
	const alt = event.altKey || event.getModifierState?.("Alt");
	const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : null;
	return alt && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
		(event.code === code || (key && event.key?.toLowerCase() === key));
}

export function consume_key(event) {
	event.preventDefault();
	event.stopImmediatePropagation();
}
