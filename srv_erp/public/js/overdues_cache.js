// Frappe caches Page scripts in localStorage across reloads.
// Discard the earlier receivables page so Desk fetches the manual register.
(() => {
	try {
		const key = "_page:overdues";
		const cached = localStorage.getItem(key);
		if (cached && !cached.includes("OVERDUES_MANUAL_REGISTER_V22")) {
			localStorage.removeItem(key);
		}
	} catch (_) {
		// Desk can load the page directly when browser storage is unavailable.
	}
})();
