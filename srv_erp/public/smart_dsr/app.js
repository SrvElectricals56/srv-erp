/* Smart DSR — browser workday. All business authority remains on the server. */
(() => {
	"use strict";
	const root = document.getElementById("smart-dsr");
	// Desk links leave the embedded workday rather than nesting another Desk.
	if (window.self !== window.top) {
		root.addEventListener("click", (event) => {
			const link = event.target.closest("a[href]");
			if (link && new URL(link.href, location.href).pathname.startsWith("/app"))
				link.target = "_top";
		});
	}
	const s = {
		profile: null,
		data: null,
		details: null,
		busy: false,
		error: "",
		tracking: "Waiting for location",
		watch: null,
		networkWatch: null,
		stream: null,
		cameraCleanup: null,
		challenge: null,
		dutyLocation: null,
		locationRequired: false,
		permissionObserverStarted: false,
		historyFilters: { from: "", to: "", status: "" },
		overdues: null,
		expensePage: { filters: null, start: 0 },
		partyItemOptions: null,
	};
	const esc = (v) =>
		String(v ?? "").replace(
			/[&<>"']/g,
			(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
		);
	const money = (v) =>
		new Intl.NumberFormat("en-IN", {
			style: "currency",
			currency: s.details?.outstanding.currency || s.profile?.currency || "INR",
		}).format(Number(v || 0));
	const date = (v) =>
		v
			? new Date(String(v).replace(" ", "T")).toLocaleString("en-IN", {
					timeZone: "Asia/Kolkata",
					year: "numeric",
					month: "short",
					day: "2-digit",
					hour: "2-digit",
					minute: "2-digit",
					hour12: true,
			  })
			: "—";
	const uid = () => crypto.randomUUID();
	const duty = () => s.data?.duty;
	const active = () => duty()?.status === "Active";
	const todayDuty = () => duty() || null;
	const visitId = () =>
		location.hash.startsWith("#visit/") ? decodeURIComponent(location.hash.slice(7)) : null;
	const duration = (seconds) => {
		if (seconds == null || seconds === "" || !Number.isFinite(Number(seconds))) return "—";
		const value = Math.max(0, Number(seconds));
		if (value > 0 && value < 60) return "<1 min";
		const minutes = Math.floor(value / 60),
			hours = Math.floor(minutes / 60),
			remaining = minutes % 60;
		return hours ? `${hours} hr${remaining ? ` ${remaining} min` : ""}` : `${minutes} min`;
	};
	const button = (text, action, disabled = false, cls = "") =>
		`<button type="button" class="${cls}" data-action="${action}" ${
			disabled ? "disabled" : ""
		}>${text}</button>`;
	const field = (label, name, type = "text", attrs = "") =>
		`<label>${label}<input name="${name}" type="${type}" ${attrs}></label>`;
	function indianVehicleNumber(value) {
		if (!/^[A-Za-z0-9\s-]+$/.test(value) || value.length > 30) return null;
		const number = value.replace(/[\s-]/g, "").toUpperCase();
		const bh = number.match(/^(2[1-9]|[3-9][0-9])BH([0-9]{4})([A-HJ-NP-Z]{1,2})$/);
		if (bh && Number(bh[2]) > 0) return number;
		const state = number.match(/^([A-Z]{2})([0-9]{1,2})([A-Z]{0,3})([0-9]{1,4})$/);
		const codes =
			"AN AP AR AS BR CG CH DD DL DN GA GJ HP HR JH JK KA KL LA LD MH ML MN MP MZ NL OD OR PB PY RJ SK TN TR TS TG UK UA UP WB".split(
				" "
			);
		if (state && codes.includes(state[1]) && Number(state[2]) > 0 && Number(state[4]) > 0)
			return state[1] + state[2] + state[3] + state[4].padStart(4, "0");
		return null;
	}
	async function api(method, args = {}, namespace = "srv_erp.smart_dsr.api.") {
		const response = await fetch("/api/method/" + namespace + method, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Frappe-CSRF-Token": window.smart_dsr_csrf,
			},
			body: JSON.stringify(args),
		});
		const result = await response.json();
		if (!response.ok || result.exc) {
			if (response.status === 401)
				window.top.location.assign("/login?redirect-to=/app/smart-dsr");
			let message = result.message || result.exc_type || "Request failed";
			try {
				const messages = JSON.parse(result._server_messages || "[]");
				if (messages.length) message = JSON.parse(messages[0]).message;
			} catch (_) {
				// Keep the fallback when optional cached data or error details are unavailable.
			}
			throw Error(String(message).replace(/<[^>]*>/g, ""));
		}
		return result.message;
	}
	const fetchExpenseHistory = (args) =>
		api("list_expenses", args, "srv_erp.smart_dsr.home_expenses.");
	async function gps({
		action = "this action",
		maximumAge = 0,
		fast = false,
		maxAccuracy = null,
	} = {}) {
		if (!window.isSecureContext || !navigator.geolocation)
			throw Error("Location requires HTTPS or localhost and browser location support.");
		const request = (enableHighAccuracy) =>
			new Promise((resolve, reject) => {
				navigator.geolocation.getCurrentPosition(
					(p) => {
						if (
							maximumAge > 0 &&
							(!Number.isFinite(p.timestamp) ||
								Date.now() - p.timestamp > maximumAge ||
								p.timestamp > Date.now() + 1000)
						)
							return reject({ code: 2 });
						resolve({
							latitude: p.coords.latitude,
							longitude: p.coords.longitude,
							accuracy: p.coords.accuracy,
						});
					},
					reject,
					{
						enableHighAccuracy,
						timeout: fast
							? enableHighAccuracy
								? 8000
								: 5000
							: enableHighAccuracy
							? 20000
							: 15000,
						maximumAge,
					}
				);
			});
		const failure = (e) => {
			if (e.code === 1)
				return Error(
					`Location permission is blocked. Allow Location for this site in your browser and enable device Location, then retry ${action}.`
				);
			if (e.code === 3)
				return Error(
					`Location request timed out. Enable device Location and retry ${action} near a window or outdoors. ${
						action.startsWith("photo")
							? "Your photo is saved; retry location beside it."
							: "Nothing was submitted."
					}${
						action === "Duty OFF"
							? " If location remains unavailable, ask an Administrator to authorize an ending GPS exception in the control panel."
							: ""
					}`
				);
			return Error(
				`Your device could not determine its current location. Enable device Location, check your connection and retry ${action} near a window or outdoors. ${
					action.startsWith("photo")
						? "Your photo is saved; retry location beside it."
						: "Nothing was submitted."
				}${
					action === "Duty OFF"
						? " If location remains unavailable, ask an Administrator to authorize an ending GPS exception in the control panel."
						: ""
				}`
			);
		};
		if (maxAccuracy != null) {
			return new Promise((resolve, reject) => {
				let watch,
					best = Infinity,
					settled = false;
				const finish = (point, error) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					if (watch !== undefined) navigator.geolocation.clearWatch(watch);
					error ? reject(error) : resolve(point);
				};
				const timer = setTimeout(
					() =>
						finish(
							null,
							Number.isFinite(best)
								? Error(
										`${action} needs GPS accuracy within ${maxAccuracy} m. Best reading was ±${Math.round(
											best
										)} m. Enable precise location for this site and device, move near a window or outdoors, and retry.`
								  )
								: failure({ code: 3 })
						),
					25000
				);
				watch = navigator.geolocation.watchPosition(
					(p) => {
						if (
							!Number.isFinite(p.timestamp) ||
							Date.now() - p.timestamp > 10000 ||
							p.timestamp > Date.now() + 1000
						)
							return;
						const { latitude, longitude, accuracy } = p.coords;
						if (
							![latitude, longitude, accuracy].every(Number.isFinite) ||
							Math.abs(latitude) > 90 ||
							Math.abs(longitude) > 180 ||
							accuracy < 0
						)
							return;
						best = Math.min(best, accuracy);
						if (accuracy <= maxAccuracy) finish({ latitude, longitude, accuracy });
					},
					(e) => {
						if (e.code === 1) finish(null, failure(e));
					},
					{ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
				);
				if (settled) navigator.geolocation.clearWatch(watch);
			});
		}
		if (fast) {
			// Race GPS with network-assisted positioning instead of waiting for two timeouts.
			try {
				return await Promise.any([request(true), request(false)]);
			} catch (e) {
				throw failure(e.errors?.find((item) => item.code === 1) || e.errors?.[0] || e);
			}
		}
		try {
			return await request(true);
		} catch (e) {
			if (e.code === 1) throw failure(e);
			// A fresh network-assisted fix can succeed when high-accuracy GPS cannot.
			try {
				return await request(false);
			} catch (retryError) {
				throw failure(retryError);
			}
		}
	}

	async function sample(point, trackedDuty = duty()) {
		if (trackedDuty?.status !== "Active") return;
		const result = await api("gps_batch", {
			duty: trackedDuty.name,
			points: [
				{
					...point,
					id: uid(),
					captured_at: point.captured_at || new Date().toISOString(),
				},
			],
		});
		if (result.fuel_reimbursement !== undefined && duty()?.name === trackedDuty.name) {
			s.data.fuel_reimbursement = result.fuel_reimbursement;
			const cost = root.querySelector("[data-fuel-cost]");
			if (cost) cost.textContent = money(result.fuel_reimbursement);
		}
		if (result.estimated_km !== undefined) trackedDuty.estimated_km = result.estimated_km;
		if (result.verified_km !== undefined) {
			trackedDuty.verified_km = result.verified_km;
			if (duty()?.name === trackedDuty.name) {
				const n = root.querySelectorAll(".metric strong")[2];
				if (n) {
					n.textContent = Number(result.verified_km).toFixed(2) + " KM";
					const detail = n.parentElement.querySelector("small");
					if (detail)
						detail.textContent = `Verified · Estimated tracked distance: ${Number(
							trackedDuty.estimated_km || trackedDuty.verified_km || 0
						).toFixed(2)} KM`;
				}
			}
		}
		return result;
	}
	function showLocationWarning(required) {
		required = required && s.profile.current?.duty?.status === "Active";
		const changed = required && !s.locationRequired;
		s.locationRequired = required;
		const warning = root.querySelector("#location-required");
		if (warning) warning.hidden = !required;
		if (changed) {
			api("gps_interruption", {
				duty: s.profile.current.duty.name,
				reason: "Location disabled or unavailable while Duty is ON. Salesperson prompted to restore location.",
			}).catch(() => {});
		}
	}
	function restartLocationWatch() {
		for (const field of ["watch", "networkWatch"]) {
			if (s[field] !== null) navigator.geolocation?.clearWatch(s[field]);
			s[field] = null;
		}
		watch();
	}
	async function observeLocationPermission() {
		if (s.permissionObserverStarted || !navigator.permissions?.query) return;
		s.permissionObserverStarted = true;
		try {
			const permission = await navigator.permissions.query({ name: "geolocation" });
			const changed = () => {
				if (s.profile.current?.duty?.status !== "Active") return;
				if (permission.state === "denied") showLocationWarning(true);
				else restartLocationWatch();
			};
			permission.addEventListener("change", changed);
			if (permission.state === "denied") showLocationWarning(true);
		} catch (_) {
			/* Location watch errors cover browsers without this permission observer. */
		}
	}

	function watch() {
		if (s.profile.current?.duty?.status !== "Active") {
			for (const field of ["watch", "networkWatch"]) {
				if (s[field] !== null) navigator.geolocation?.clearWatch(s[field]);
				s[field] = null;
			}
			showLocationWarning(false);
			return;
		}
		observeLocationPermission();
		if (!navigator.geolocation) {
			showLocationWarning(true);
			return;
		}
		if (s.watch !== null) return;
		let last = 0,
			bestAccuracy = Infinity,
			uploading = false;
		const show = () => {
			const node = root.querySelector("[data-tracking]");
			if (node) node.textContent = s.tracking;
		};
		const fallback = () => {
			if (s.networkWatch !== null) return;
			s.networkWatch = navigator.geolocation.watchPosition(receive, failed, {
				enableHighAccuracy: false,
				maximumAge: 0,
				timeout: 15000,
			});
		};
		const failed = (error) => {
			if (error.code !== 1) fallback();
			if (error.code !== 1 && Date.now() - last < 60000) return;
			showLocationWarning(true);
			s.tracking =
				error.code === 1
					? "Location permission blocked — enable location to track travel"
					: "Waiting for GPS or network-assisted location — distance gaps remain unverified";
			show();
		};
		const receive = async (position) => {
			const stamp = position.timestamp;
			if (!Number.isFinite(stamp) || Date.now() - stamp > 60000 || stamp > Date.now() + 1000)
				return;
			const accuracy = position.coords.accuracy;
			if (accuracy > 50) fallback();
			if (uploading || s.busy || (Date.now() - last < 15000 && accuracy >= bestAccuracy / 2))
				return;
			uploading = true;
			try {
				const result = await sample(
					{
						latitude: position.coords.latitude,
						longitude: position.coords.longitude,
						accuracy,
						captured_at: new Date(stamp).toISOString(),
					},
					s.profile.current?.duty
				);
				last = Date.now();
				bestAccuracy = accuracy;
				showLocationWarning(false);
				s.tracking = `${
					accuracy > 50 ? "Approximate live location" : "Live GPS location"
				}: ${position.coords.latitude.toFixed(5)}, ${position.coords.longitude.toFixed(
					5
				)} · accuracy ±${Math.round(accuracy)} m${
					result?.gps_status === "Interrupted"
						? " · distance estimated where possible"
						: ""
				}`;
			} catch (error) {
				s.tracking = error.message;
			} finally {
				uploading = false;
			}
			show();
		};
		s.watch = navigator.geolocation.watchPosition(receive, failed, {
			enableHighAccuracy: true,
			maximumAge: 0,
			timeout: 20000,
		});
	}

	async function load() {
		const activity = visitId();
		const [profile, details, overdues, partyItemOptions] = await Promise.all([
			api("bootstrap"),
			activity ? api("visit_details", { activity }) : Promise.resolve(null),
			overduesOnly() ? api("allocated_dealer_overdues") : Promise.resolve(null),
			partyItemsOnly()
				? api("options", {}, "srv_erp.smart_dsr.party_items.")
				: Promise.resolve(null),
		]);
		s.profile = profile;
		s.overdues = overdues;
		s.partyItemOptions = partyItemOptions;
		s.data = profile.current;
		s.details = details;
		if (s.details && s.details.visit.duty !== s.data?.duty?.name)
			s.data = await api("summary", { duty: s.details.visit.duty });
		if (location.hash.startsWith("#dsr/"))
			s.data = await api("summary", { duty: decodeURIComponent(location.hash.slice(5)) });
		if (
			location.hash === "#new-dsr" &&
			!s.profile.current?.duty?.status?.match(/^(Active|Closed)$/)
		) {
			s.data = null;
			s.profile.official_opening_balance =
				s.profile.current?.available_cash ?? s.profile.official_opening_balance;
		}
		render();
		openHomeSection();
		watch();
		if (activity || location.hash.startsWith("#dsr/"))
			window.scrollTo({ top: 0, left: 0, behavior: "instant" });
	}
	let homeSectionOpened = false;
	function openHomeSection() {
		if (homeSectionOpened) return;
		homeSectionOpened = true;
		const section = new URLSearchParams(location.search).get("section");
		if (section === "history" || (section === "expenses" && !expensesOnly())) {
			root.querySelector(
				section === "history" ? "#dsr-history" : "#dsr-expenses"
			)?.scrollIntoView({ block: "start" });
		} else if (section === "overdues" && !overduesOnly()) {
			void run(dealerOverdues);
		} else if (section === "collect") {
			const panel = root.querySelector(".add-visit");
			if (panel) {
				const hint = document.createElement("p");
				hint.className = "hint";
				hint.textContent =
					"To collect money, open or add the party visit, upload the shop photo, then choose Collected Money. Duty must be ON.";
				panel.before(hint);
				hint.scrollIntoView({ block: "center" });
			}
		} else if (section === "collections") {
			const rows = s.data?.collections || [];
			modal(
				"Collections",
				`<p>Collections for the current DSR. Open a previous DSR in DSR History to view its collections.</p><div class="table-scroll"><table><thead><tr><th>Customer</th><th>Amount</th><th>Method</th><th>Status</th></tr></thead><tbody>${
					rows
						.map(
							(row) =>
								`<tr><td>${esc(row.customer)}</td><td>${money(
									row.amount
								)}</td><td>${esc(row.payment_method)}</td><td>${esc(
									row.verification_status
								)}</td></tr>`
						)
						.join("") || '<tr><td colspan="4">No collections recorded.</td></tr>'
				}</tbody></table></div>`
			);
		}
	}
	function overdueNotification() {
		const count = Math.max(0, Number(s.profile.overdue_count || 0));
		const label = `${count} overdue payment${
			count === 1 ? "" : "s"
		} from your allocated dealers`;
		return `<button type="button" class="overdue-notification" data-action="dealer-overdues" aria-label="${esc(
			label
		)}" title="${esc(
			label
		)}"><svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 5v5m0 3h.01"/></svg><span>Overdues</span><span class="overdue-count" aria-hidden="true">${count}</span></button>`;
	}
	function header() {
		if (window.self !== window.top && new URLSearchParams(location.search).get("desk") === "1")
			return "";
		return `<header class="dsr-header"><a class="brand" href="/app/smart-dsr"><span class="brand-mark">SRV</span><span>SRV Electricals<small>Smart DSR</small></span></a><div class="header-account">${
			s.profile.can_admin ? '<a href="/smart-dsr/admin">Administrator Panel</a>' : ""
		}<span>${esc(s.profile.employee_name)}<small>${new Date().toLocaleDateString("en-IN", {
			dateStyle: "full",
			timeZone: "Asia/Kolkata",
		})}</small></span>${window.smart_dsr_sales_home ? "" : overdueNotification()}${button(
			"Notifications",
			"notifications"
		)}<a href="/app/user/${encodeURIComponent(window.smart_dsr_user)}">Profile</a>${button(
			"Logout",
			"logout"
		)}</div></header>`;
	}
	function liveCameraMarkup(attributes, label) {
		return `<div class="dsr-camera-frame"><video autoplay playsinline muted aria-label="${esc(
			label
		)}"></video><span class="dsr-camera-live">Live camera</span><span class="dsr-camera-guide" aria-hidden="true"></span></div><div class="dsr-camera-controls"><button type="button" class="dsr-camera-shutter" ${attributes}><span aria-hidden="true"></span>Capture Photo</button></div>`;
	}
	function capturedPhotoMarkup(url, label, caption = "Photo captured") {
		return `<div class="dsr-camera-photo"><img class="shop-photo" src="${esc(url)}" alt="${esc(
			label
		)}"><span>${esc(caption)}</span></div>`;
	}
	async function returnToWorkday(message) {
		stopCamera();
		root.querySelector("#dsr-dialog")?.close();
		if (location.hash) history.replaceState(null, "", location.pathname + location.search);
		await load();
		error(Error(message || "Complete unfinished tasks before Duty OFF."));
	}

	function odometerDistance(d) {
		return d?.odometer_start_photo && d?.odometer_end_photo
			? `${Number(d.odometer_distance || 0).toFixed(2)} KM`
			: "—";
	}
	function meterPhoto(url, label) {
		return `<button type="button" data-meter-photo="${esc(url)}" data-meter-label="${esc(
			label
		)}">View ${esc(label)}</button>`;
	}
	function odometerFields(phase) {
		const label = phase === "start" ? "Starting Meter (KM)" : "Ending Meter (KM)";
		return `<fieldset class="odometer-capture"><legend>${
			phase === "start" ? "Starting" : "Ending"
		} Meter</legend>${field(
			label,
			"odometer_reading",
			"number",
			'min="0" step="0.01" required'
		)}<div data-odometer-camera></div><button type="button" data-open-odometer>${
			phase === "start" ? "Upload Starting Meter Photo" : "Upload Ending Meter Photo"
		}</button><p data-odometer-error role="alert" hidden></p></fieldset>`;
	}
	function bindOdometerCamera(form, phase, getContext, onChange) {
		let photo = null;
		let snapshot = null;
		const container = form.querySelector("[data-odometer-camera]");
		const input = form.elements.odometer_reading;
		const button = form.querySelector("[data-open-odometer]");
		const reset = () => {
			if (container.querySelector("video")) stopCamera();
			photo = null;
			snapshot = null;
			container.replaceChildren();
			button.hidden = false;
			button.textContent =
				phase === "start" ? "Upload Starting Meter Photo" : "Upload Ending Meter Photo";
		};
		const current = () => ({ phase, reading: input.value, ...getContext() });
		const valid = () => photo && snapshot === JSON.stringify(current());
		form._refreshOdometer = onChange;
		input.addEventListener("input", () => {
			if (photo || container.querySelector("video")) reset();
			onChange();
		});
		button.onclick = () =>
			run(async () => {
				const box = form.querySelector("[data-odometer-error]");
				box.hidden = true;
				try {
					if (!input.reportValidity()) return;
					if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
						throw Error(
							"Live meter capture requires HTTPS and browser camera support."
						);
					const captureContext = current();
					if (phase === "start" && !captureContext.vehicle_number)
						throw Error(
							"Ask Administrator to allocate a vehicle, or add your vehicle before opening the meter camera."
						);
					reset();
					onChange();
					const challenge = await api("odometer_camera_challenge", captureContext);
					stopCamera();
					const stream = await navigator.mediaDevices.getUserMedia({
						video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
						audio: false,
					});
					if (
						!form.isConnected ||
						(form.closest("dialog") && !form.closest("dialog").open)
					) {
						stream.getTracks().forEach((track) => track.stop());
						return;
					}
					s.stream = stream;
					s.cameraCleanup = () => {
						container.replaceChildren();
						button.hidden = false;
					};
					button.hidden = true;
					container.innerHTML = liveCameraMarkup(
						"data-capture-odometer",
						"Live meter camera"
					);
					const video = container.querySelector("video");
					video.srcObject = stream;
					await video.play();
					container.querySelector("[data-capture-odometer]").onclick = () =>
						run(async () => {
							if (!video.videoWidth)
								throw Error("Camera is not ready. Please retry.");
							if (JSON.stringify(current()) !== JSON.stringify(captureContext))
								throw Error(
									"The meter reading or vehicle changed. Open the camera again."
								);
							const canvas = document.createElement("canvas");
							const scale = Math.min(
								1,
								1280 / Math.max(video.videoWidth, video.videoHeight)
							);
							canvas.width = Math.round(video.videoWidth * scale);
							canvas.height = Math.round(video.videoHeight * scale);
							canvas
								.getContext("2d")
								.drawImage(video, 0, 0, canvas.width, canvas.height);
							const url = canvas.toDataURL("image/jpeg", 0.85);
							photo = { challenge, content: url.split(",")[1] };
							snapshot = JSON.stringify(captureContext);
							stopCamera();
							container.innerHTML = capturedPhotoMarkup(
								url,
								`${phase === "start" ? "Starting" : "Ending"} meter photo`
							);
							button.hidden = false;
							button.textContent = "Retake Photo";
							onChange();
						});
				} catch (e) {
					reset();
					onChange();
					box.textContent =
						e.name === "NotAllowedError"
							? "Camera permission is blocked. Allow camera access and try again."
							: e.message;
					box.hidden = false;
					throw e;
				}
			});
		return {
			valid,
			reset,
			get photo() {
				return photo;
			},
		};
	}
	async function endDuty() {
		const currentDuty = duty();
		const readiness = await api("duty_off_readiness", { duty: currentDuty.name });
		if (!readiness.ready) return returnToWorkday(readiness.message);
		stopCamera();
		const d = modal(
			"Duty OFF",
			`<form><div data-no-visit-reason ${
				readiness.requires_no_visit_reason ? "" : "hidden"
			}><p class="hint">No completed dealer visits: this duty will not count as duty time. All meal, fuel and other expense benefits will be reversed.</p><label>Reason for Duty OFF without visits<textarea name="duty_off_reason" maxlength="2000" ${
				readiness.requires_no_visit_reason ? "required" : ""
			}></textarea></label></div><p>Starting Meter: <strong>${
				currentDuty.odometer_start_photo
					? Number(currentDuty.odometer_start).toFixed(2) + " KM"
					: "Not recorded"
			}</strong></p>${odometerFields(
				"end"
			)}<p class="odometer-distance" data-odometer-distance>Distance travelled: —</p><p data-duty-off-error role="alert" hidden></p><button class="primary" type="submit" data-submit-duty-off disabled>Duty OFF</button></form>`
		);
		d.onclose = stopCamera;
		const form = d.querySelector("form");
		let requiresReason = Boolean(readiness.requires_no_visit_reason);
		const refresh = () => {
			const end = Number(form.elements.odometer_reading.value);
			const hasValue =
				form.elements.odometer_reading.value !== "" &&
				form.elements.odometer_reading.checkValidity();
			const delta = end - Number(currentDuty.odometer_start);
			form.querySelector("[data-odometer-distance]").textContent =
				currentDuty.odometer_start_photo && hasValue
					? delta >= 0
						? `Distance travelled: ${delta.toFixed(2)} KM`
						: "Ending reading must be at least the starting reading."
					: "Distance travelled: —";
			form.querySelector("[data-submit-duty-off]").disabled =
				!hasValue ||
				(currentDuty.odometer_start_photo && delta < 0) ||
				!camera.valid() ||
				(requiresReason && !form.elements.duty_off_reason.value.trim());
		};
		form.elements.duty_off_reason.oninput = refresh;
		const camera = bindOdometerCamera(
			form,
			"end",
			() => ({ duty: currentDuty.name }),
			refresh
		);
		form.onsubmit = (event) => {
			event.preventDefault();
			run(async () => {
				const errorBox = form.querySelector("[data-duty-off-error]");
				try {
					if (!camera.valid())
						throw Error("Capture the ending meter photo before Duty OFF.");
					const readiness = await api("duty_off_readiness", { duty: currentDuty.name });
					if (!readiness.ready) return returnToWorkday(readiness.message);
					requiresReason = Boolean(readiness.requires_no_visit_reason);
					form.querySelector("[data-no-visit-reason]").hidden = !requiresReason;
					form.elements.duty_off_reason.required = requiresReason;
					if (requiresReason && !form.elements.duty_off_reason.value.trim()) {
						refresh();
						throw Error(
							"Enter a reason for Duty OFF without completed dealer visits."
						);
					}
					let point;
					try {
						point = await gps({ action: "Duty OFF", maximumAge: 30000 });
					} catch (e) {
						if (!currentDuty.gps_exception) throw e;
					}
					await api("end_workday", {
						duty: currentDuty.name,
						gps: point || null,
						odometer_end: form.elements.odometer_reading.value,
						odometer_photo: camera.photo,
						duty_off_reason: form.elements.duty_off_reason.value.trim(),
					});
					d.close();
					await load();
				} catch (e) {
					try {
						const readiness = await api("duty_off_readiness", {
							duty: currentDuty.name,
						});
						if (!readiness.ready) return returnToWorkday(readiness.message);
					} catch (_) {
						// Keep the fallback when optional cached data or error details are unavailable.
					}
					errorBox.textContent = e.message;
					errorBox.hidden = false;
					throw e;
				}
			});
		};
	}

	function dutySection() {
		if (s.profile.configured === false)
			return `<section class="panel"><h2>Duty ON / OFF</h2><p>Please ask Administrator to configure the company in DSR Settings before starting duty.</p></section>`;
		const d = duty();
		if (active())
			return `<section class="panel"><div class="section-title"><h2>Duty ON / OFF</h2><span class="badge success">● Duty ON</span></div><div class="duty-active"><div><strong>${esc(
				d.vehicle_number
			)}</strong><p>Started ${date(
				d.started_at
			)} · <span data-duration></span></p><small data-tracking>${esc(
				s.tracking
			)}</small></div><div class="duty-meter-actions">${
				d.odometer_start_photo
					? `<div class="duty-meter"><p>Starting Meter: <strong>${Number(
							d.odometer_start
					  ).toFixed(2)} KM</strong></p>${meterPhoto(
							d.odometer_start_photo,
							"Starting meter photo"
					  )}</div>`
					: ""
			}${button(
				"Duty OFF",
				"off",
				false,
				"danger"
			)}</div></div><p class="hint">Keep this browser open for foreground GPS. Closed or suspended browsers cannot track continuously.</p></section>`;
		if (d && !active())
			return `<section class="panel"><div class="section-title"><h2>Duty ON / OFF</h2><span class="badge">Duty OFF · ${
				d.no_visit_duty ? "No Visits — Excluded" : esc(d.status)
			}</span></div>${
				d.no_visit_duty
					? `<p><strong>Reason:</strong> ${esc(
							d.duty_off_reason
					  )}. Benefits reversed; duty time excluded.</p>`
					: ""
			}<p>Ended ${date(d.ended_at)} · Closing balance ${money(
				s.data.available_cash
			)}</p><p class="odometer-distance">Meter distance travelled: ${odometerDistance(
				d
			)}</p>${
				d.odometer_start_photo
					? meterPhoto(d.odometer_start_photo, "Starting meter photo")
					: ""
			} ${
				d.odometer_end_photo ? meterPhoto(d.odometer_end_photo, "Ending meter photo") : ""
			}${
				d.status === "Closed" ? button("Finalize DSR", "finalize", false, "primary") : ""
			}</section>`;
		const allocated = s.profile.vehicles?.[0];
		return `<section class="panel"><div class="section-title"><h2>Duty ON / OFF</h2><span class="badge">● Duty OFF</span></div><form id="duty-form"><div class="form-grid"><div class="allocated-vehicle"><strong>Allocated Vehicle</strong><p>${esc(
			allocated?.registration_number || "No vehicle allocated"
		)}</p><small>${esc(s.profile.employee_name)}</small>${
			allocated?.validation_error
				? `<p class="hint">${esc(allocated.validation_error)}</p>`
				: ""
		}<input type="hidden" name="vehicle" value="${esc(
			allocated?.registration_number || ""
		)}"><button type="button" data-add-vehicle>Add Vehicle</button></div><div class="duty-location"><strong>Current Location</strong><div data-duty-location role="status">Fetching your current location…</div><button type="button" data-refresh-location hidden>Retry Location</button></div>${odometerFields(
			"start"
		)}</div><button class="primary" type="submit" id="start-duty" disabled>Duty ON</button><span class="hint"> GPS permission is required.</span></form><dialog id="vehicle-dialog"><form id="vehicle-form" method="dialog"><div class="section-title"><h3>Add Vehicle</h3><button type="button" data-cancel-vehicle aria-label="Close Add Vehicle">×</button></div><p>Salesperson: <strong>${esc(
			s.profile.employee_name
		)}</strong></p>${field(
			"Vehicle Number",
			"registration_number",
			"text",
			"required"
		)}<label>Fuel Type<select name="fuel_type" required><option>Petrol</option><option>Diesel</option><option>CNG</option></select></label>${[
			["insurance", "Insurance"],
			["puc", "PUC"],
			["rc", "RC"],
			["fastag", "FASTag"],
		]
			.map(
				([key, label]) =>
					`<input type="hidden" name="${key}_available" value="0"><label class="dsr-checkbox-option"><input type="checkbox" name="${key}_available" value="1" required><span>${label} Available</span></label>`
			)
			.join("")}${field("Insurance Expiry (optional)", "insurance_expiry", "date")}${field(
			"PUC Expiry (optional)",
			"puc_expiry",
			"date"
		)}${field(
			"RC Expiry (optional)",
			"rc_expiry",
			"date"
		)}<label>Status<select name="status"><option>Active</option><option>Inactive</option></select></label><div class="actions"><button type="button" data-cancel-vehicle>Cancel</button><button class="primary">Save Vehicle</button></div></form></dialog></section>`;
	}
	const cashDisplay = (value) => (value == null ? "Not initialized" : money(value));
	function cards() {
		const d = todayDuty();
		return `<div class="summary-cards">${[
			[
				"Opening Balance",
				cashDisplay(d?.opening_balance ?? s.profile.official_opening_balance),
			],
			[
				"Closing Balance",
				cashDisplay(
					(d ? s.data?.available_cash : null) ?? s.profile.official_opening_balance
				),
			],
			["Total Distance", `${Number(d?.verified_km || 0).toFixed(2)} KM`],
			["Total Time", "<span data-duration>0 min</span>"],
			["Fuel Cost", money(d ? s.data?.fuel_reimbursement || 0 : 0)],
		]
			.map(
				([title, value]) =>
					`<section class="metric"><span>${title}</span><strong${
						title === "Fuel Cost" ? " data-fuel-cost" : ""
					}>${value}</strong>${
						title === "Fuel Cost" ? "<small>Verified KM × fuel rate</small>" : ""
					}${
						title === "Total Distance"
							? `<small>Verified · Estimated tracked distance: ${Number(
									d?.estimated_km || d?.verified_km || 0
							  ).toFixed(2)} KM</small>`
							: ""
					}</section>`
			)
			.join("")}</div>`;
	}
	function visits() {
		const rows = [...(todayDuty() ? s.data?.activities || [] : [])].sort(
			(a, b) => (a.visit_number || 0) - (b.visit_number || 0)
		);
		return `<section class="panel"><div class="section-title"><h2>Party Visits</h2><small>${
			rows.length
		} visits</small></div><div class="table-scroll"><table><thead><tr><th>Visit</th><th>Dealer / Party</th><th>Points Earned</th><th>Details</th></tr></thead><tbody>${
			rows.length
				? rows
						.map(
							(v, i) =>
								`<tr><td>${i + 1}</td><td>${esc(v.customer_name || "Dealer")} ${
									v.status === "Open"
										? '<span class="badge pending">Pending</span>'
										: ""
								}</td><td>${
									v.status === "Open"
										? "Pending"
										: v.reward_rule_version
										? (Number(v.reward_points) > 0 ? "+" : "") +
										  Number(v.reward_points || 0)
										: "—"
								}</td><td><a href="#visit/${encodeURIComponent(
									v.name
								)}">Show Details</a></td></tr>`
						)
						.join("")
				: '<tr><td colspan="4" class="empty">No party visits recorded yet.</td></tr>'
		}</tbody></table></div>${button(
			"+ Add Visit",
			"add",
			!active(),
			"primary add-visit"
		)}</section>`;
	}
	function deletePendingVisit(activity) {
		stopCamera();
		const d = modal(
			"Delete Pending Visit",
			'<p>Delete this pending visit? It will be removed from Party Visits.</p><p data-delete-error role="alert" hidden></p><div class="actions"><button type="button" data-cancel-delete>Cancel</button><button type="button" class="danger" data-confirm-delete>Delete Visit</button></div>'
		);
		d.querySelector("[data-cancel-delete]").onclick = () => d.close();
		d.querySelector("[data-confirm-delete]").onclick = () =>
			run(async () => {
				try {
					await api("delete_pending_visit", { activity });
					d.close();
					if (visitId() === activity) location.hash = "";
					else await load();
				} catch (e) {
					const box = d.querySelector("[data-delete-error]");
					box.textContent = e.message;
					box.hidden = false;
					throw e;
				}
			});
	}

	function nightStaySection() {
		if (duty()?.no_visit_duty) return "";
		const info = s.data?.night_stay;
		if (!todayDuty() || !info) return "";
		const stay = info.active;
		const latest = info.latest;
		const coordinates = (row, prefix = "") =>
			`${Number(row[prefix + "latitude"]).toFixed(5)}, ${Number(
				row[prefix + "longitude"]
			).toFixed(5)}`;
		return `<section class="panel" id="night-stay"><div class="section-title"><h2>Night Stay</h2><span class="badge ${
			stay ? "success" : ""
		}">${stay ? "ON" : "OFF"}</span></div>${
			stay
				? `<p>Started ${date(
						stay.checked_in_at
				  )} · <span data-night-duration></span></p><p>ON location: ${esc(
						coordinates(stay)
				  )}</p><p>OFF available from ${date(
						info.off_available_at
				  )}. Return within 500 metres of the ON location.</p>${button(
						"Night Stay OFF",
						"night-off",
						!info.can_off,
						"primary"
				  )}`
				: `<p>${esc(info.message)}</p>${
						latest?.checked_out_at
							? `<p>Last stay: ${date(latest.checked_in_at)} → ${date(
									latest.checked_out_at
							  )} · ${duration(
									Number(latest.duration_minutes) * 60
							  )}</p><p>ON location: ${esc(
									coordinates(latest)
							  )}<br>OFF location: ${esc(
									coordinates(latest, "checkout_")
							  )}</p><p>Distance from ON: ${Number(
									latest.checkout_distance_m || 0
							  ).toFixed(0)} m · Expense ${money(latest.expense_amount || 0)}</p>`
							: ""
				  }${button("Night Stay ON", "night-on", !info.can_on, "primary")}`
		}</section>`;
	}
	function nightStayOn() {
		const request_key = uid();
		const dutyName = duty().name;
		const d = modal(
			"Night Stay ON",
			'<p>Your current location will be recorded. Night Stay OFF requires at least four hours and a return within 500 metres of this location.</p><p data-night-error role="alert" hidden></p><button class="primary" data-confirm-night>Night Stay ON</button>'
		);
		d.querySelector("[data-confirm-night]").onclick = () =>
			run(async () => {
				try {
					const box = d.querySelector("[data-night-error]");
					box.textContent = "Waiting for an accurate GPS location…";
					box.hidden = false;
					const point = await gps({
						action: "Night Stay ON",
						maxAccuracy: s.data.night_stay.max_accuracy_m || 50,
					});
					await api("night_stay_on", {
						duty: dutyName,
						gps: point,
						address: "Current location",
						request_key,
					});
					d.close();
					await load();
				} catch (e) {
					const box = d.querySelector("[data-night-error]");
					box.textContent = e.message;
					box.hidden = false;
					throw e;
				}
			});
	}
	function nightStayOff() {
		const stay = s.data.night_stay.active;
		const d = modal(
			"Night Stay OFF",
			'<p>Your current location will be checked against the ON location. A successful OFF records a ₹1,200 night stay expense and deducts it from your closing balance.</p><p data-night-error role="alert" hidden></p><button class="primary" data-confirm-night>Night Stay OFF</button>'
		);
		d.querySelector("[data-confirm-night]").onclick = () =>
			run(async () => {
				try {
					const box = d.querySelector("[data-night-error]");
					box.textContent = "Waiting for an accurate GPS location…";
					box.hidden = false;
					const point = await gps({
						action: "Night Stay OFF",
						maxAccuracy: s.data.night_stay.max_accuracy_m || 50,
					});
					await api("night_stay_off", { stay: stay.name, gps: point });
					d.close();
					await load();
				} catch (e) {
					const box = d.querySelector("[data-night-error]");
					box.textContent = e.message;
					box.hidden = false;
					throw e;
				}
			});
	}

	function expensesSection() {
		const rows = todayDuty() ? s.data?.expenses || [] : [];
		return `<section class="panel" id="dsr-expenses"><div class="section-title"><h2>Expenses</h2>${button(
			"+ Add Expense",
			"expense",
			!active(),
			"primary"
		)}</div><div class="table-scroll"><table><thead><tr><th>Expense</th><th>Amount</th><th>Remarks</th><th>Receipt</th><th>Status</th></tr></thead><tbody>${
			rows
				.map(
					(row) =>
						`<tr><td>${esc(row.category)}</td><td>${money(row.amount)}</td><td>${esc(
							row.remarks || "—"
						)}</td><td>${
							row.receipt?.startsWith("/private/files/")
								? `<a href="${esc(
										row.receipt
								  )}" target="_blank" rel="noopener">View Receipt</a>`
								: "—"
						}</td><td>${esc(row.posting_status || "Recorded")}</td></tr>`
				)
				.join("") ||
			'<tr><td colspan="5" class="empty">No expenses recorded yet.</td></tr>'
		}</tbody></table></div></section>`;
	}
	function addExpense() {
		stopCamera();
		let receipt = null;
		const request_key = uid();
		const dutyName = duty().name;
		const d = modal(
			"Add Expense",
			`<form><label>Expense Type<select name="category" required><option>Fuel (CNG/Petrol/Diesel)</option><option>Other Expense</option></select></label>${field(
				"Amount",
				"value",
				"number",
				'min="0.01" step="0.01" required'
			)}<label>Remarks<textarea name="remarks" maxlength="4000"></textarea></label><fieldset><legend>Receipt (required)</legend><div data-receipt-camera></div><button type="button" data-open-receipt>Open Receipt Camera</button></fieldset><p data-expense-error role="alert" hidden></p><button class="primary">Save Expense</button></form>`
		);
		d.onclose = stopCamera;
		const categoryField = d.querySelector('[name="category"]');
		const remarksField = d.querySelector('[name="remarks"]');
		categoryField.onchange = () => {
			remarksField.required = categoryField.value === "Other Expense";
		};
		categoryField.onchange();
		const cameraButton = d.querySelector("[data-open-receipt]");
		cameraButton.onclick = () =>
			run(async () => {
				try {
					if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
						throw Error(
							"Receipt capture requires HTTPS and a browser with camera support."
						);
					const challenge = await api("receipt_camera_challenge", {
						duty: dutyName,
						request_key,
					});
					stopCamera();
					const stream = await navigator.mediaDevices.getUserMedia({
						video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
						audio: false,
					});
					if (!d.open) {
						stream.getTracks().forEach((track) => track.stop());
						return;
					}
					s.stream = stream;
					const container = d.querySelector("[data-receipt-camera]");
					s.cameraCleanup = () => {
						container.innerHTML = receipt
							? capturedPhotoMarkup(
									"data:image/jpeg;base64," + receipt.content,
									"Captured receipt"
							  )
							: "";
						cameraButton.hidden = false;
					};
					cameraButton.hidden = true;
					container.innerHTML = liveCameraMarkup(
						"data-capture-receipt",
						"Live receipt camera"
					);
					const video = container.querySelector("video");
					video.srcObject = stream;
					await video.play();
					container.querySelector("[data-capture-receipt]").onclick = () =>
						run(async () => {
							if (!video.videoWidth)
								throw Error("Camera is not ready. Please retry.");
							const canvas = document.createElement("canvas");
							const scale = Math.min(
								1,
								1280 / Math.max(video.videoWidth, video.videoHeight)
							);
							canvas.width = Math.round(video.videoWidth * scale);
							canvas.height = Math.round(video.videoHeight * scale);
							canvas
								.getContext("2d")
								.drawImage(video, 0, 0, canvas.width, canvas.height);
							const dataURL = canvas.toDataURL("image/jpeg", 0.85);
							receipt = {
								filename: "receipt.jpg",
								content: dataURL.split(",")[1],
								challenge,
							};
							stopCamera();
							container.innerHTML = capturedPhotoMarkup(dataURL, "Captured receipt");
							cameraButton.hidden = false;
							cameraButton.textContent = "Retake Photo";
						});
				} catch (e) {
					stopCamera();
					cameraButton.hidden = false;
					const preview = d.querySelector("[data-receipt-camera]");
					if (preview)
						preview.innerHTML = receipt
							? capturedPhotoMarkup(
									"data:image/jpeg;base64," + receipt.content,
									"Captured receipt"
							  )
							: "";
					const box = d.querySelector("[data-expense-error]");
					if (box && d.open) {
						box.textContent =
							e.name === "NotAllowedError"
								? "Camera permission is blocked. Allow camera access for this site and try again."
								: e.message;
						box.hidden = false;
					}
					throw e;
				}
			});
		d.querySelector("form").onsubmit = (event) => {
			event.preventDefault();
			run(async () => {
				const form = event.target;
				const errorBox = form.querySelector("[data-expense-error]");
				errorBox.hidden = true;
				try {
					if (s.stream) throw Error("Capture the receipt photo before saving.");
					const data = new FormData(form);
					await api("record_expense", {
						duty: dutyName,
						category: data.get("category"),
						value: data.get("value"),
						paid_from_cash: 0,
						remarks: data.get("remarks"),
						receipt_file: receipt,
						request_key,
					});
					d.close();
					if (expensesOnly()) s.expensePage.start = 0;
					await load();
				} catch (e) {
					errorBox.textContent = e.message;
					errorBox.hidden = false;
					throw e;
				}
			});
		};
	}

	const actionIcon = (name) => {
		const paths = {
			order: "M3 3h2l3 12h11l3-8H6M9 20h.01M18 20h.01",
			overdue: "M14 2H6v20h14V8zM14 2v6h6M12 11v5M12 19h.01",
			collection: "M3 12h4l3-3h7a2 2 0 0 1 0 4h-5M3 19h4l5 2 9-7M4 12v8M9 4h6M12 1v6",
			reviews: "M21 15a3 3 0 0 1-3 3H8l-5 4V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3zM7 7h10M7 12h7",
		};
		return `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]}"></path></svg>`;
	};
	const pendingPhotoLocation = () =>
		s.details?.photos.find(
			(photo) => photo.capture_source === "Browser camera pending location"
		);
	function visitPhotoDetails() {
		const v = s.details.visit;
		const photo = s.details.photos[s.details.photos.length - 1];
		const pending = pendingPhotoLocation();
		return `<h3>Photo and Visit Details</h3><p><strong>Photo time:</strong> ${
			photo ? date(photo.captured_at) : "Upload a shop photo first"
		}</p><p><strong>Location:</strong> <span data-visit-location-label>${
			!photo
				? "Captured after photo upload"
				: pending
				? s.photoLocationKey === `${v.name}:${photo?.name}`
					? "Fetching live location…"
					: "Location pending"
				: "Live location recorded"
		}</span></p><div data-duty-location></div>${
			pending && s.photoLocationKey !== `${v.name}:${photo?.name}`
				? button("Retry Location", "photo-location")
				: ""
		}<p><strong>GPS accuracy:</strong> ${
			photo && !pending
				? "±" + Math.round(Number(photo.accuracy || 0)) + " m"
				: "Waiting for location"
		}</p><h3>Distance and Travel Time</h3><p>From ${
			v.origin_activity ? "Previous dealer visit" : "Duty ON"
		}</p><strong>${
			!photo || pending
				? "Calculating after location…"
				: v.travel_verification === "Verified GPS samples"
				? Number(v.travel_distance_km).toFixed(2) + " KM"
				: "Distance unverified"
		}</strong><p>${
			!photo || pending ? "—" : duration(v.travel_duration_seconds)
		} travel time</p><small>${
			!photo || pending
				? ""
				: esc(v.travel_verification || "Historical travel; verification unavailable")
		}</small><p class="hint">${
			!photo || pending ? "" : date(v.travel_started_at) + " → " + date(v.arrived_at)
		}</p>`;
	}
	function updateVisitPhotoDetails() {
		const panel = root.querySelector("[data-visit-photo-details]");
		if (panel) panel.innerHTML = visitPhotoDetails();
		panel
			?.querySelector('[data-action="photo-location"]')
			?.addEventListener("click", () =>
				finishVisitLocation(visitId(), pendingPhotoLocation())
			);
		const submit = root.querySelector('[data-action="submit"]');
		if (submit)
			submit.disabled = !active() || !s.details.photos.length || !!pendingPhotoLocation();
		const reward = root.querySelector("[data-visit-reward]");
		if (reward && s.details.visit.reward_started_at && s.details.visit.status === "Open")
			reward.innerHTML = `Reward timer: ${date(
				s.details.visit.reward_started_at
			)} · <span data-reward-duration></span> elapsed`;
		tick();
	}
	async function finishVisitLocation(activity, photo, positionPromise = null) {
		if (!photo) return;
		const key = `${activity}:${photo.name}`;
		if (s.photoLocationKey === key) return;
		s.photoLocationKey = key;
		if (visitId() === activity && s.error.startsWith("Photo saved.")) {
			s.error = "";
			const banner = root.querySelector("#dsr-error");
			if (banner) banner.hidden = true;
		}
		let livePoint = null;
		if (visitId() === activity) updateVisitPhotoDetails();
		try {
			const result = await (positionPromise ||
				gps({ action: "photo location", maximumAge: 5000, fast: true }).then(
					(point) => ({ point }),
					(error) => ({ error })
				));
			if (result.error) throw result.error;
			livePoint = result.point;
			const details = await api("browser_photo_location", {
				activity,
				photo: photo.name,
				gps: result.point,
			});
			if (
				visitId() === activity &&
				s.details?.photos.some((item) => item.name === photo.name)
			)
				s.details = details;
		} catch (e) {
			if (
				visitId() === activity &&
				s.details?.photos.some((item) => item.name === photo.name)
			)
				error(
					Error("Photo saved. " + e.message + " Use Retry Location beside the photo.")
				);
		} finally {
			if (s.photoLocationKey === key) s.photoLocationKey = null;
			if (
				visitId() === activity &&
				s.details?.photos.some((item) => item.name === photo.name)
			) {
				updateVisitPhotoDetails();
				const panel = root.querySelector("[data-visit-photo-details]");
				if (panel && livePoint && !pendingPhotoLocation())
					void showDutyLocation(panel, livePoint);
			}
		}
	}
	function visitPanel() {
		const v = s.details.visit;
		const read = v.status === "Completed";
		const info = s.details;
		const photoReady = info.photos.length > 0;
		let review = {};
		try {
			review = JSON.parse(v.dealer_review || "{}");
		} catch (_) {
			// Keep the fallback when optional cached data or error details are unavailable.
		}
		return `<section class="panel"><div class="section-title"><div><a href="#">← Party Visits</a><h2>Party Visit ${esc(
			v.visit_number || ""
		)}</h2></div><span class="badge ${read ? "success" : "pending"}">${
			read ? "Submitted · Read only" : "Pending"
		}</span></div><h3>${esc(info.dealer.customer_name)}</h3><p>${esc(
			info.dealer.mobile_no || "No contact number"
		)} · ${
			photoReady || read
				? "Arrival " + date(v.arrived_at)
				: "Upload a shop photo to start this visit"
		}${
			read ? " · Departure " + date(v.departed_at) : ""
		}</p><p class="hint" data-visit-reward>Reward timer: ${
			v.reward_started_at
				? date(v.reward_started_at) + " · <span data-reward-duration></span> elapsed"
				: "Starts after shop photo upload"
		}${
			read && v.reward_rule_version
				? " · Verified near dealer: " +
				  duration(v.reward_near_seconds) +
				  " · Order value: " +
				  money(v.reward_order_amount) +
				  " · Points: " +
				  Number(v.reward_points)
				: ""
		}</p>${
			photoReady
				? `<p class="hint">Photo uploaded. Visit services are ready.</p>`
				: `<p class="hint">Upload the live shop photo first to enable visit services. Location is captured with the photo.</p>`
		}<div class="visit-grid"><section class="subpanel"><h3>Live Shop Photo</h3>${
			info.photos
				.map((p) =>
					capturedPhotoMarkup(
						p.photo,
						"Private shop evidence",
						"Captured " + date(p.captured_at)
					)
				)
				.join("") || '<p class="hint">A live camera photo is required.</p>'
		}${
			!read ? button(info.photos.length ? "Retake Photo" : "Open Camera", "camera") : ""
		}<div id="camera-view"></div></section><section class="subpanel" data-visit-photo-details>${visitPhotoDetails()}</section></div><div class="business-grid">${[
			["🛒", "Make Order", "order", "Use the standard ERPNext Sales Order form."],
			["▤", "Overdue Amount", "overdue", money(info.outstanding.overdue)],
			["₹", "Collected Money", "collection", "Record cash or noncash collections."],
			["▧", "Dealer Reviews", "reviews", "Visit remarks."],
		]
			.map(
				([icon, title, action, text]) =>
					`<button class="business-card" data-action="${action}" ${
						!photoReady || (read && action === "order") ? "disabled" : ""
					}><span class="business-icon">${actionIcon(
						action
					)}</span><strong>${title}</strong><small>${text}</small></button>`
			)
			.join("")}</div><div class="linked-records"><h3>Sales Orders</h3>${
			info.orders
				.map(
					(o, index) =>
						`<p><a href="/app/sales-order/${encodeURIComponent(o.name)}">Order ${
							index + 1
						}</a> · ${money(o.grand_total)}</p>`
				)
				.join("") || '<p class="hint">No submitted orders linked.</p>'
		}<h3>Payments Collected</h3>${
			info.collections
				.map(
					(c) =>
						`<p>${money(c.amount)} · ${esc(c.payment_method)} · ${esc(
							c.verification_status
						)}</p>`
				)
				.join("") || '<p class="hint">No collections recorded.</p>'
		}${
			read
				? `<h3>Dealer Reviews</h3>${Object.entries({ remarks: review.remarks || "" })
						.map(([k, val]) => `<p><strong>${esc(k)}:</strong> ${esc(val)}</p>`)
						.join("")}`
				: ""
		}</div><div class="actions">${
			!read
				? button(
						"Submit Visit",
						"submit",
						!active() || !photoReady || !!pendingPhotoLocation(),
						"primary"
				  ) +
				  `<button type="button" data-delete-visit="${esc(v.name)}" ${
						!active() ? "disabled" : ""
				  }>Delete Visit</button>`
				: ""
		}${button(
			"Back to Party Visits",
			"back"
		)}</div><p class="hint">Submitting a visit keeps your duty ON.</p></section>`;
	}
	const partyItemsOnly = () =>
		new URLSearchParams(location.search).get("section") === "party-items" &&
		!location.hash.replace(/^#/, "");
	const expensesOnly = () =>
		new URLSearchParams(location.search).get("section") === "expenses" &&
		!location.hash.replace(/^#/, "");
	const overduesOnly = () =>
		new URLSearchParams(location.search).get("section") === "overdues" &&
		!location.hash.replace(/^#/, "");
	const historyOnly = () =>
		new URLSearchParams(location.search).get("section") === "history" &&
		!location.hash.replace(/^#/, "");
	function dsrHistory() {
		const excluded = historyOnly() && duty()?.status !== "Active" ? null : duty()?.name;
		const reports = (s.profile.duties || []).filter((row) => row.name !== excluded);
		if (!reports.length && !historyOnly()) return "";
		const filter = s.historyFilters;
		const rows = reports.filter(
			(row) =>
				(!filter.from || row.work_date >= filter.from) &&
				(!filter.to || row.work_date <= filter.to) &&
				(!filter.status ||
					(filter.status === "no-visits"
						? !!row.no_visit_duty
						: row.status === filter.status))
		);
		const totals = [
			["Expenses", "expense_total"],
			["Opening Balance", "opening_balance"],
			["Closing Balance", "closing_balance"],
		]
			.map(
				([label, key]) =>
					`<div class="metric"><span>${label}</span><strong>${money(
						rows.reduce((total, row) => total + Number(row[key] || 0), 0)
					)}</strong></div>`
			)
			.join("");
		const statuses = [
			["", "All statuses"],
			["Active", "Active"],
			["Closed", "Closed"],
			["Finalized", "Finalized"],
			["no-visits", "No Visits — Excluded"],
		];
		const applied = [
			["from", filter.from && `From: ${filter.from}`],
			["to", filter.to && `To: ${filter.to}`],
			[
				"status",
				filter.status &&
					`Status: ${
						statuses.find(([value]) => value === filter.status)?.[1] || filter.status
					}`,
			],
		].filter(([, label]) => label);
		return `<section class="panel" id="dsr-history"><div class="section-title"><h2>Previous DSRs ${
			applied.length
				? `<span class="badge history-filter-count">${applied.length} active</span>`
				: ""
		}</h2><small role="status">${rows.length} of ${
			reports.length
		} reports</small></div><form data-history-filters><div class="history-filter-toolbar"><label>From Date<input type="date" name="from" value="${esc(
			filter.from
		)}"></label><label>To Date<input type="date" name="to" value="${esc(
			filter.to
		)}"></label><label>Status<select name="status" aria-label="Status">${statuses
			.map(
				([value, label]) =>
					`<option value="${value}" ${
						filter.status === value ? "selected" : ""
					}>${label}</option>`
			)
			.join(
				""
			)}</select></label><button type="submit" class="primary">Apply Filters</button><button type="button" data-clear-history>Clear Filters</button></div>${
			applied.length
				? `<div class="history-active-filters" aria-label="Applied filters">${applied
						.map(
							([key, label]) =>
								`<button type="button" data-remove-history-filter="${key}" aria-label="Remove ${esc(
									label
								)}">${esc(label)} <span aria-hidden="true">×</span></button>`
						)
						.join("")}</div>`
				: ""
		}<p class="hint">${
			historyOnly()
				? "Filters apply to your previous DSRs. Your active DSR is excluded."
				: "Filters apply to all your DSRs, excluding the report currently open."
		}</p></form><div class="history-totals" aria-label="Filtered DSR totals" aria-live="polite">${totals}</div><div class="table-scroll"><table><thead><tr><th>Date</th><th>Status</th><th>Expenses</th><th>Opening Balance</th><th>Closing Balance</th><th>Details</th></tr></thead><tbody>${
			rows
				.map(
					(row) =>
						`<tr><td>${esc(row.work_date)}</td><td>${
							row.no_visit_duty ? "No Visits — Excluded" : esc(row.status)
						}</td><td>${money(row.expense_total || 0)}</td><td>${money(
							row.opening_balance || 0
						)}</td><td>${money(
							row.closing_balance || 0
						)}</td><td><a href="#dsr/${encodeURIComponent(
							row.name
						)}">View DSR</a></td></tr>`
				)
				.join("") ||
			'<tr><td colspan="6" class="empty">No DSRs match these filters.</td></tr>'
		}</tbody></table></div></section>`;
	}
	function bindHistoryFilters() {
		const form = root.querySelector("[data-history-filters]");
		if (!form) return;
		const update = (filters) => {
			s.historyFilters = filters;
			root.querySelector("#dsr-history").outerHTML = dsrHistory();
			bindHistoryFilters();
		};
		const apply = (report = true) => {
			const { from, to, status } = form.elements;
			to.setCustomValidity(
				from.value && to.value && from.value > to.value
					? "To Date must be on or after From Date."
					: ""
			);
			if (!(report ? form.reportValidity() : form.checkValidity())) return false;
			update({ from: from.value, to: to.value, status: status.value });
			return true;
		};
		form.oninput = () => form.elements.to.setCustomValidity("");
		form.onsubmit = (event) => {
			event.preventDefault();
			apply();
		};
		form.querySelector("[data-clear-history]").onclick = () =>
			update({ from: "", to: "", status: "" });
		form.querySelectorAll("[data-remove-history-filter]").forEach((button) => {
			button.onclick = () =>
				update({ ...s.historyFilters, [button.dataset.removeHistoryFilter]: "" });
		});
	}

	function nextDsr() {
		return duty() && !active()
			? `<section class="panel"><p>Your DSR has ended. Start another DSR when you are ready.</p>${button(
					"Add another DSR",
					"another-dsr",
					false,
					"primary"
			  )}</section>`
			: "";
	}
	function render() {
		stopCamera();
		if (partyItemsOnly()) {
			root.innerHTML = `<main class="dsr-main dsr-party-items-page"><div id="dsr-error" role="alert" ${
				s.error ? "" : "hidden"
			}>${esc(
				s.error
			)}</div><div data-party-items-page></div></main><dialog id="dsr-dialog"></dialog>`;
			window.smartDsrPartyItems.render(root.querySelector("[data-party-items-page]"), {
				options: s.partyItemOptions,
				fetch: (args) => api("report", args, "srv_erp.smart_dsr.party_items."),
			});
			return;
		}
		if (expensesOnly()) {
			root.innerHTML = `<main class="dsr-main dsr-expenses-page"><div id="dsr-error" role="alert" ${
				s.error ? "" : "hidden"
			}>${esc(
				s.error
			)}</div><div data-expenses-page></div></main><dialog id="dsr-dialog"></dialog>`;
			window.smartDsrExpenses.render(root.querySelector("[data-expenses-page]"), {
				state: s.expensePage,
				active: active(),
				dutyName: duty()?.name,
				duties: s.profile.duties,
				fetch: (args) => fetchExpenseHistory(args),
				add: () => run(addExpense),
				details: (row, currency) => {
					const value = new Intl.NumberFormat("en-IN", {
						style: "currency",
						currency,
					}).format(Number(row.amount || 0));
					modal(
						"Expense Details",
						`<dl>${[
							["Expense", row.name],
							["Expense Type", row.category],
							["Amount", value],
							["Date", date(row.recorded_at)],
							["Status", row.posting_status || "Recorded"],
							["DSR", row.duty || "—"],
							["DSR Date", row.work_date || "—"],
							["DSR Status", row.duty_status || "—"],
							["Remarks", row.remarks || "—"],
						]
							.map(([label, value]) => `<dt>${label}</dt><dd>${esc(value)}</dd>`)
							.join("")}</dl>${
							row.receipt?.startsWith("/private/files/")
								? `<a href="${esc(
										row.receipt
								  )}" target="_blank" rel="noopener">View Receipt</a>`
								: "<p>No receipt attached.</p>"
						}`
					);
				},
			});
			return;
		}
		if (overduesOnly()) {
			root.innerHTML = `<main class="dsr-main dsr-overdues-page"><div id="dsr-error" role="alert" ${
				s.error ? "" : "hidden"
			}>${esc(
				s.error
			)}</div><div data-overdues-page></div></main><dialog id="dsr-dialog"></dialog>`;
			window.smartDsrOverdues.render(root.querySelector("[data-overdues-page]"), {
				data: s.overdues,
				employee: s.profile.employee_name,
				refresh: () => api("allocated_dealer_overdues"),
				details: async (row) => {
					const dues = await api("outstanding", { customer: row.customer });
					const entries = (dues.entries || dues.invoices || []).filter(
						(entry) => entry.days_overdue > 0 && entry.currency === row.currency
					);
					const amount = (value) =>
						new Intl.NumberFormat("en-IN", {
							style: "currency",
							currency: row.currency,
						}).format(Number(value || 0));
					modal(
						"Party Overdues",
						`<h3>${esc(dues.dealer.customer_name)}</h3><p>Total overdue: <strong>${esc(
							amount(
								entries.reduce(
									(total, entry) => total + Number(entry.outstanding_amount),
									0
								)
							)
						)}</strong></p><div class="table-scroll"><table><thead><tr><th>Manual Entry</th><th>Due Date</th><th>Outstanding</th><th>Days Overdue</th></tr></thead><tbody>${
							entries
								.map(
									(entry) =>
										`<tr><td>${esc(entry.name)}</td><td>${esc(
											entry.due_date
										)}</td><td>${esc(
											amount(entry.outstanding_amount)
										)}</td><td>${Number(entry.days_overdue)}</td></tr>`
								)
								.join("") ||
							'<tr><td colspan="4">No overdue entries remain.</td></tr>'
						}</tbody></table></div>`
					);
				},
			});
			return;
		}
		if (historyOnly()) {
			root.innerHTML = `<main class="dsr-main dsr-history-page"><div id="dsr-error" role="alert" ${
				s.error ? "" : "hidden"
			}>${esc(s.error)}</div>${dsrHistory()}</main><dialog id="dsr-dialog"></dialog>`;
			bindHistoryFilters();
			return;
		}
		root.innerHTML =
			header() +
			`<main class="dsr-main"><div class="page-intro"><div><p class="eyebrow">DAILY SALES REPORT</p><div class="workday-heading"><h1>Your workday, in one place.</h1><div class="reward-balance" aria-label="Total reward points"><span>Reward points</span><strong>${Number(
				s.profile.reward_points || 0
			)}</strong></div>${
				window.smart_dsr_sales_home ? overdueNotification() : ""
			}</div></div><span class="hint">${esc(
				s.profile.employee_name || ""
			)}</span></div><aside id="location-required" class="location-required" role="alert" ${
				s.locationRequired ? "" : "hidden"
			}><strong>Keep location ON — your duty is ON.</strong><p>Location must remain enabled throughout your duty. Turn on your device Location and allow Location permission for Smart DSR. If you have finished work, complete Duty OFF.</p><button type="button" data-action="restore-location">Retry Location</button></aside><div id="dsr-error" role="alert" ${
				s.error ? "" : "hidden"
			}>${esc(s.error)}</div>${
				s.details
					? visitPanel()
					: dutySection() +
					  nightStaySection() +
					  cards() +
					  visits() +
					  expensesSection() +
					  nextDsr() +
					  dsrHistory()
			}<footer>SRV Electricals · Smart DSR</footer></main><dialog id="dsr-dialog"></dialog>`;
		if (new URLSearchParams(location.search).get("section") === "history") {
			const back = document.createElement("a");
			back.href = "#";
			back.textContent = "Back to Previous DSRs";
			back.className = "history-back-link";
			root.querySelector("main").prepend(back);
		}
		root.querySelector("main").prepend(root.querySelector("#dsr-error"));
		bind();
		tick();
	}
	function tick() {
		const d = todayDuty();
		const sec =
			d && !d.no_visit_duty
				? (new Date(d.ended_at || Date.now()) -
						new Date(String(d.started_at).replace(" ", "T"))) /
						1000 -
				  Number(d.closed_gap_seconds || 0)
				: 0;
		root.querySelectorAll("[data-duration]").forEach((n) => (n.textContent = duration(sec)));
		const stay = s.data?.night_stay?.active;
		if (stay) {
			const elapsed =
				(Date.now() - new Date(String(stay.checked_in_at).replace(" ", "T"))) / 1000;
			root.querySelectorAll("[data-night-duration]").forEach(
				(node) => (node.textContent = duration(elapsed))
			);
		}
		const visit = s.details?.visit;
		if (visit?.reward_started_at) {
			const end = visit.departed_at
				? new Date(String(visit.departed_at).replace(" ", "T"))
				: new Date();
			const elapsed =
				(end - new Date(String(visit.reward_started_at).replace(" ", "T"))) / 1000;
			root.querySelectorAll("[data-reward-duration]").forEach(
				(node) => (node.textContent = duration(elapsed))
			);
		}
	}
	function setLoading(loading) {
		let overlay = document.getElementById("dsr-loading");
		if (!overlay) {
			overlay = document.createElement("div");
			overlay.id = "dsr-loading";
			overlay.hidden = true;
			overlay.setAttribute("popover", "manual");
			overlay.setAttribute("role", "status");
			overlay.setAttribute("aria-label", "Loading, please wait");
			overlay.innerHTML =
				'<span class="dsr-spinner" aria-hidden="true"></span><span>Loading…</span>';
			document.body.append(overlay);
		}
		if (loading) {
			overlay.hidden = false;
			// The top layer also keeps the spinner visible above open dialogs.
			if (overlay.showPopover && !overlay.matches(":popover-open")) overlay.showPopover();
		} else {
			if (overlay.hidePopover && overlay.matches(":popover-open")) overlay.hidePopover();
			overlay.hidden = true;
		}
	}
	function error(e) {
		s.error = e.message || "Something went wrong. Please try again.";
		let n = root.querySelector("#dsr-error");
		if (!n) {
			n = document.createElement("div");
			n.id = "dsr-error";
			n.setAttribute("role", "alert");
		}
		(root.querySelector("main") || root).prepend(n);
		n.hidden = false;
		n.textContent = s.error;
		const dialog = root.querySelector("dialog[open]");
		if (dialog) {
			let banner = dialog.querySelector(".dsr-dialog-error");
			if (!banner) {
				banner = document.createElement("div");
				banner.className = "dsr-dialog-error";
				banner.setAttribute("role", "alert");
				dialog.prepend(banner);
			}
			banner.textContent = s.error;
			banner.hidden = false;
			dialog.scrollTop = 0;
		}
		window.scrollTo({ top: 0, left: 0, behavior: "instant" });
	}

	async function run(fn, { loading = true } = {}) {
		if (s.busy) return;
		s.busy = true;
		root.setAttribute("aria-busy", "true");
		if (loading) setLoading(true);
		root.querySelectorAll("button").forEach((b) => {
			b.dataset.wasDisabled = b.disabled ? "1" : "0";
			b.disabled = true;
		});
		try {
			s.error = "";
			root.querySelectorAll("#dsr-error, .dsr-dialog-error").forEach((node) => {
				node.hidden = true;
			});
			await fn();
		} catch (e) {
			error(e);
		} finally {
			s.busy = false;
			if (loading) setLoading(false);
			root.removeAttribute("aria-busy");
			root.querySelectorAll("button[data-was-disabled]").forEach((b) => {
				b.disabled = b.dataset.wasDisabled === "1";
				delete b.dataset.wasDisabled;
			});
			root.querySelectorAll("form").forEach((form) => form._refreshOdometer?.());
			if (s.pendingNavigation) {
				s.pendingNavigation = false;
				queueMicrotask(() => run(load));
			}
		}
	}
	function modal(title, body) {
		const d = root.querySelector("#dsr-dialog");
		d.onclose = null;
		d.innerHTML = `<div class="section-title"><h2>${title}</h2><button data-close type="button" aria-label="Close">×</button></div>${body}`;
		d.querySelector("[data-close]").onclick = () => d.close();
		d.showModal();
		return d;
	}
	function stopCamera() {
		if (s.stream) s.stream.getTracks().forEach((t) => t.stop());
		s.stream = null;
		const cleanup = s.cameraCleanup;
		s.cameraCleanup = null;
		cleanup?.();
	}
	function openVisitCamera() {
		if (!s.details.photos.length) return captureShop();
		const d = modal(
			"Retake Photo",
			'<p>This will remove the previous uploaded image. Capturing a replacement will update the visit time and location to the new photo’s capture time and location.</p><div class="actions"><button type="button" data-cancel-retake>Cancel</button><button type="button" class="primary" data-confirm-retake>Remove Previous Photo and Retake</button></div>'
		);
		d.querySelector("[data-cancel-retake]").onclick = () => d.close();
		d.querySelector("[data-confirm-retake]").onclick = () =>
			run(async () => {
				d.close();
				await captureShop(true);
			});
	}

	async function captureShop(retake = false) {
		if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
			throw Error(
				"Live camera capture requires HTTPS and a supported browser. Contact Administrator for an authorized exception."
			);
		s.challenge = await api(retake ? "retake_visit_photo" : "browser_photo_challenge", {
			activity: visitId(),
		});
		if (retake) await load();
		const container = root.querySelector("#camera-view");
		const cameraButton = root.querySelector('[data-action="camera"]');
		if (!container || !cameraButton) return;
		const restoreCamera = () => {
			stopCamera();
			container.replaceChildren();
			cameraButton.hidden = false;
		};
		try {
			s.stream = await navigator.mediaDevices.getUserMedia({
				video: { facingMode: { ideal: "environment" }, width: { ideal: 1600 } },
				audio: false,
			});
			if (!container.isConnected) {
				stopCamera();
				return;
			}
			s.cameraCleanup = () => {
				container.replaceChildren();
				cameraButton.hidden = false;
			};
			cameraButton.hidden = true;
			container.innerHTML = liveCameraMarkup(
				'id="capture-photo"',
				"Live party visit camera"
			);
			const video = container.querySelector("video");
			video.srcObject = s.stream;
			await video.play();
			container.querySelector("#capture-photo").onclick = () =>
				run(async () => {
					try {
						if (!video.videoWidth) throw Error("Camera is not ready. Retry.");
						const canvas = document.createElement("canvas");
						const scale = Math.min(
							1,
							1280 / Math.max(video.videoWidth, video.videoHeight)
						);
						canvas.width = Math.round(video.videoWidth * scale);
						canvas.height = Math.round(video.videoHeight * scale);
						canvas
							.getContext("2d")
							.drawImage(video, 0, 0, canvas.width, canvas.height);
						const image = canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
						const activity = visitId();
						container.querySelector("#capture-photo").textContent = "Uploading photo…";
						// GPS starts at capture but never delays sending the photo.
						const position = gps({
							action: "photo location",
							maximumAge: 5000,
							fast: true,
						}).then(
							(point) => ({ point }),
							(error) => ({ error })
						);
						const photo = await api("browser_photo", {
							activity,
							challenge: s.challenge,
							image_base64: image,
						});
						stopCamera();
						if (visitId() !== activity) return;
						s.details.photos = [photo];
						s.details.visit.arrived_at = photo.captured_at;
						render();
						// Keep the saved photo and services usable while location/details finish.
						void finishVisitLocation(activity, photo, position);
					} catch (e) {
						restoreCamera();
						throw e;
					}
				});
		} catch (e) {
			restoreCamera();
			throw e;
		}
	}

	async function add() {
		const open = s.data?.activities.find((v) => v.status === "Open");
		if (open) {
			location.hash = "visit/" + open.name;
			return;
		}
		const d = modal(
			"Add Party Visit",
			`<label>Search existing dealer<input id="dealer-search" placeholder="Dealer, firm or mobile"></label><p id="dealer-count" class="hint" role="status"></p><div id="dealer-results"></div>`
		);
		let timer = 0,
			request = 0;
		async function search() {
			const current = ++request;
			const rows = await api("search_dealers", {
				search: d.querySelector("input").value,
			});
			if (current !== request) return;
			d.querySelector("#dealer-count").textContent = `${rows.length} dealer${
				rows.length === 1 ? "" : "s"
			} found`;
			d.querySelector("#dealer-results").innerHTML =
				rows
					.map(
						(c) =>
							`<button class="dealer-result" data-customer="${esc(
								c.name
							)}"><strong>${esc(c.customer_name)}</strong><small>${esc(
								c.mobile_no || ""
							)} · ${esc(c.territory)}</small></button>`
					)
					.join("") || "<p>No assigned dealers found.</p>";
			d.querySelectorAll("[data-customer]").forEach(
				(b) =>
					(b.onclick = () =>
						run(async () => {
							b.disabled = true;
							const label = b.innerHTML;
							b.textContent = "Opening visit…";
							try {
								const id = await api("dealer_arrival", {
									duty: duty().name,
									customer: b.dataset.customer,
									request_key: uid(),
								});
								d.close();
								location.hash = "visit/" + id;
							} finally {
								b.innerHTML = label;
							}
						}))
			);
		}
		d.querySelector("input").oninput = () => {
			clearTimeout(timer);
			timer = setTimeout(() => search().catch(error), 250);
		};
		await search();
	}
	async function dealerOverdues() {
		const result = await api("allocated_dealer_overdues");
		s.profile.overdue_count = (result.rows || []).reduce(
			(total, row) => total + Number(row.entry_count || 0),
			0
		);
		const notification = root.querySelector(".overdue-notification");
		if (notification) {
			notification.outerHTML = overdueNotification();
			root.querySelector(".overdue-notification").onclick = () => run(dealerOverdues);
		}

		const amount = (value, currency) =>
			new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(
				Number(value || 0)
			);
		const totals = Object.entries(result.totals || {})
			.map(([currency, value]) => esc(amount(value, currency)))
			.join(" · ");
		modal(
			"Party Overdues",
			`<p>Manually recorded overdue balances for dealers allocated to ${esc(
				s.profile.employee_name
			)}.</p>${
				totals ? `<p>Total overdue: <strong>${totals}</strong></p>` : ""
			}<div class="table-scroll dealer-overdues-table"><table><thead><tr><th>Dealer / Party</th><th>Overdue Amount</th><th>Entries</th><th>Oldest Due Date</th><th>Days Overdue</th></tr></thead><tbody>${
				(result.rows || [])
					.map(
						(row) =>
							`<tr><td data-label="Dealer / Party">${esc(
								row.customer_name
							)}</td><td data-label="Overdue Amount">${esc(
								amount(row.overdue_amount, row.currency)
							)}</td><td data-label="Entries">${Number(
								row.entry_count || 0
							)}</td><td data-label="Oldest Due Date">${esc(
								row.oldest_due_date
							)}</td><td data-label="Days Overdue">${Number(
								row.days_overdue
							)}</td></tr>`
					)
					.join("") ||
				'<tr><td colspan="5" class="empty">No overdue amounts for your allocated dealers.</td></tr>'
			}</tbody></table></div>`
		);
	}

	async function overdue() {
		const details = await api("visit_details", { activity: visitId() });
		s.details.outstanding = details.outstanding;
		const dues = s.details.outstanding;
		const cardAmount = root.querySelector('[data-action="overdue"] small');
		if (cardAmount) cardAmount.textContent = money(dues.overdue);
		modal(
			"Overdue Amount",
			`<p>Total overdue: <strong>${money(
				dues.overdue
			)}</strong></p><div class="table-scroll"><table><thead><tr><th>Manual Entry</th><th>Due date</th><th>Outstanding</th><th>Days overdue</th></tr></thead><tbody>${
				(dues.entries || dues.invoices || [])
					.filter((i) => i.days_overdue > 0)
					.map(
						(i, index) =>
							`<tr><td>${esc(i.name || "Entry " + (index + 1))}</td><td>${esc(
								i.due_date
							)}</td><td>${esc(i.currency)} ${esc(i.outstanding_amount)}</td><td>${
								i.days_overdue
							}</td></tr>`
					)
					.join("") || '<tr><td colspan="4">No overdue manual entries.</td></tr>'
			}</tbody></table></div>`
		);
	}
	async function reviews() {
		let values = {};
		try {
			values = JSON.parse(s.details.visit.dealer_review || "{}");
		} catch (_) {
			// Keep the fallback when optional cached data or error details are unavailable.
		}
		const readonly = s.details.visit.status === "Completed";
		const history = await api("previous_reviews", { customer: s.details.visit.customer });
		const d = modal(
			"Dealer Reviews",
			`<form>${["remarks"]
				.map(
					(k) =>
						`<label>${
							k[0].toUpperCase() + k.slice(1)
						}<textarea name="${k}" maxlength="2000" ${
							readonly ? "readonly" : ""
						}>${esc(values[k] || "")}</textarea></label>`
				)
				.join("")}${
				!readonly ? '<button class="primary">Save Review</button>' : ""
			}</form><h3>Previous Reviews</h3>${
				history
					.map(
						(h) =>
							`<p>${date(h.arrived_at)}</p><pre>${esc(
								JSON.parse(h.dealer_review).remarks || ""
							)}</pre>`
					)
					.join("") || "<p>No previous reviews.</p>"
			}`
		);
		d.querySelector("form").onsubmit = (e) => {
			e.preventDefault();
			run(async () => {
				await api("save_visit_review", {
					activity: visitId(),
					review: Object.fromEntries(new FormData(e.target)),
				});
				d.close();
				await load();
			});
		};
	}
	function collection() {
		if (s.details.visit.status === "Completed") {
			modal(
				"Collected Money",
				s.details.collections
					.map((c) => `<p>${money(c.amount)} · ${esc(c.verification_status)}</p>`)
					.join("") || "<p>No collections recorded.</p>"
			);
			return;
		}
		const request_key = uid();
		const d = modal(
			"Collected Money",
			`<p>${esc(s.details.dealer.customer_name)}</p><form>${field(
				"Collection Amount",
				"value",
				"number",
				'min="0.01" step="0.01" required'
			)}<label>Payment Method<select name="payment_method"><option>Cash</option><option>UPI</option><option>Bank Transfer</option><option>Cheque</option></select></label>${field(
				"Transaction Reference (required for noncash)",
				"transaction_reference"
			)}<label>Remarks<textarea name="remarks"></textarea></label><p class="hint">Cash, UPI and bank transfers increase your closing balance. Cheques are recorded without increasing the closing balance. Saving this collection reduces the dealer’s recorded overdue balance and creates a linked receipt. Any amount above the unpaid balance is recorded as unapplied.</p><button class="primary">Save Collection</button></form>`
		);
		d.querySelector("form").onsubmit = (e) => {
			e.preventDefault();
			run(async () => {
				const args = Object.fromEntries(new FormData(e.target));
				await api("visit_collection", { activity: visitId(), request_key, ...args });
				d.close();
				await load();
			});
		};
	}
	const actions = {
		"restore-location": async () => {
			try {
				const point = await gps({ action: "restore live tracking" });
				await sample(point, s.profile.current?.duty);
				showLocationWarning(false);
				restartLocationWatch();
			} catch (error) {
				showLocationWarning(true);
				throw error;
			}
		},
		"dealer-overdues": dealerOverdues,
		"another-dsr": async () => {
			if (s.profile.current?.duty?.status === "Active") {
				location.hash = "";
				return;
			}
			if (s.profile.current?.duty?.status === "Closed")
				await api("finalize", { duty: s.profile.current.duty.name });
			location.hash = "new-dsr";
			window.scrollTo({ top: 0, behavior: "smooth" });
		},
		add,
		expense: addExpense,
		"night-on": nightStayOn,
		"night-off": nightStayOff,
		back: () => {
			location.hash = "";
		},
		camera: openVisitCamera,
		"photo-location": () => {
			void finishVisitLocation(visitId(), pendingPhotoLocation());
		},
		overdue,
		reviews,
		collection,
		order: async () => {
			const ref = await api("order_return_reference", { activity: visitId() });
			sessionStorage.setItem("dsr-order-return", JSON.stringify(ref));
			window.top.location.assign("/app/sales-order/new-sales-order");
		},
		submit: async () => {
			const point = await gps({ action: "Submit Visit" });
			await sample(point);
			await api("complete_activity", { activity: visitId(), gps: point });
			location.hash = "";
		},
		off: endDuty,
		finalize: async () => {
			await api("finalize", { duty: duty().name });
			await load();
		},
		notifications: () =>
			modal(
				"Notifications",
				(s.data?.events || [])
					.slice()
					.reverse()
					.map(
						(e) =>
							`<p><strong>${esc(e.event_type)}</strong> · ${date(e.recorded_at)}</p>`
					)
					.join("") || "<p>No notifications.</p>"
			),
		logout: async () => {
			const response = await fetch("/api/method/logout", {
				method: "POST",
				headers: { "X-Frappe-CSRF-Token": window.smart_dsr_csrf },
				credentials: "same-origin",
			});
			if (!response.ok) throw Error("Logout failed. Retry.");
			window.top.location.assign("/login?redirect-to=/app/smart-dsr");
		},
	};
	function isTehsil(value) {
		return (
			typeof value === "string" &&
			/\b(tehsil|tahsil|taluk|taluka|subdistrict|sub[ -]district)\b/i.test(value)
		);
	}
	async function detailedLocation(point, signal) {
		// Street names are useful only when the device fix is sufficiently precise.
		if (!Number.isFinite(point.accuracy) || point.accuracy > 100) return null;
		const params = new URLSearchParams({
			lat: String(point.latitude),
			lon: String(point.longitude),
			limit: "5",
			lang: "en",
		});
		try {
			const response = await fetch(`https://photon.komoot.io/reverse?${params}`, {
				signal,
				credentials: "omit",
				referrerPolicy: "no-referrer",
			});
			if (!response.ok) return null;
			const result = await response.json();
			for (const feature of result.features || []) {
				const coordinates = feature?.geometry?.coordinates;
				if (
					!Array.isArray(coordinates) ||
					!coordinates.slice(0, 2).every(Number.isFinite) ||
					coordinates.length < 2
				)
					continue;
				const [lon, lat] = coordinates;
				const radians = Math.PI / 180;
				const a =
					Math.sin(((lat - point.latitude) * radians) / 2) ** 2 +
					Math.cos(point.latitude * radians) *
						Math.cos(lat * radians) *
						Math.sin(((lon - point.longitude) * radians) / 2) ** 2;
				const metres = 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
				// Reverse search can return the nearest mapped object, even far away.
				if (metres > Math.max(75, point.accuracy + 50)) continue;
				const p = feature.properties || {};
				const neighbourhood =
					(p.osm_key === "place" &&
						/^(neighbourhood|suburb|quarter|residential|hamlet|village)$/.test(
							p.osm_value || ""
						)) ||
					(p.osm_key === "landuse" && p.osm_value === "residential")
						? p.name
						: null;
				const street = p.street || (p.osm_key === "highway" ? p.name : null);
				const localities = [
					neighbourhood,
					p.neighbourhood,
					p.suburb,
					p.quarter,
					p.locality,
					p.hamlet,
					p.village,
					p.district,
				].filter((value) => typeof value === "string" && value.trim() && !isTehsil(value));
				if (!street && !localities.length) continue;
				const names = [
					...localities,
					street ? [p.housenumber, street].filter(Boolean).join(" ") : null,
					p.city,
					p.county,
					p.state,
					p.postcode,
					p.country,
				];
				const seen = new Set();
				return (
					names
						.filter((value) => {
							if (typeof value !== "string" || !value.trim() || isTehsil(value))
								return false;
							const key = value.trim().toLocaleLowerCase();
							if (seen.has(key)) return false;
							seen.add(key);
							return true;
						})
						.map((value) => value.trim())
						.join(", ") || null
				);
			}
			return null;
		} catch (_) {
			return null;
		}
	}
	async function showDutyLocation(form, point) {
		const target = form.querySelector("[data-duty-location]");
		const marker = uid();
		target.dataset.lookup = marker;
		target.replaceChildren();
		const place = document.createElement("p");
		place.textContent = "Finding your current address…";
		target.append(place);
		const controller = new AbortController();
		let timer = setTimeout(() => controller.abort(), 4000);
		try {
			const detailed = await detailedLocation(point, controller.signal);
			if (detailed) {
				if (target.isConnected && target.dataset.lookup === marker) {
					place.textContent = detailed;
					return true;
				}
				return false;
			}
			clearTimeout(timer);
			// The fallback must not inherit an aborted detailed-lookup signal.
			const fallbackController = new AbortController();
			timer = setTimeout(() => fallbackController.abort(), 6000);
			// Only live, permission-granted device GPS is sent directly by this browser.
			// Never resolve stored tracking points or substitute an IP-based location.
			const params = new URLSearchParams({
				latitude: String(point.latitude),
				longitude: String(point.longitude),
				localityLanguage: "en",
			});
			const response = await fetch(
				`https://api.bigdatacloud.net/data/reverse-geocode-client?${params}`,
				{
					signal: fallbackController.signal,
					credentials: "omit",
					referrerPolicy: "no-referrer",
				}
			);
			if (!response.ok) throw Error("Location name lookup failed");
			const result = await response.json();
			if (/ip/i.test(result.lookupSource || "")) throw Error("GPS-based lookup required");
			// Include district/state details instead of showing only a town name.
			const districts = (result.localityInfo?.administrative || [])
				.filter(
					(area) =>
						/district/i.test(area.description || "") &&
						!isTehsil(area.description) &&
						!isTehsil(area.name)
				)
				.map((area) => area.name);
			const neighbourhoods = [
				...(result.localityInfo?.administrative || []),
				...(result.localityInfo?.informative || []),
			]
				.filter(
					(area) =>
						/neighbou?rhood|suburb|quarter|residential|locality|village|hamlet/i.test(
							area.description || ""
						) &&
						!isTehsil(area.description) &&
						!isTehsil(area.name)
				)
				.sort((a, b) => (Number(b.adminLevel) || 0) - (Number(a.adminLevel) || 0))
				.map((area) => area.name);
			const names = [
				...neighbourhoods,
				result.locality,
				result.city,
				...districts,
				result.principalSubdivision,
				result.postcode,
				result.countryName,
			]
				.filter((value) => typeof value === "string" && value.trim() && !isTehsil(value))
				.map((value) => value.trim());
			const seen = new Set();
			const label = names
				.filter((name) => {
					const key = name.toLocaleLowerCase();
					if (seen.has(key)) return false;
					seen.add(key);
					return true;
				})
				.join(", ");
			if (!label) throw Error("No area or city returned");
			if (target.isConnected && target.dataset.lookup === marker) {
				place.textContent = label;
				if (Number(point.accuracy) > 100) {
					const accuracy = document.createElement("small");
					accuracy.textContent =
						"Approximate device location. Enable precise location for a more accurate address.";
					target.append(accuracy);
				}
				return true;
			}
		} catch (_) {
			if (target.isConnected && target.dataset.lookup === marker)
				place.textContent =
					"Location captured. Address is unavailable. Tap Refresh Location to retry.";
		} finally {
			clearTimeout(timer);
		}
	}

	async function fetchDutyLocation(form) {
		const refresh = form.querySelector("[data-refresh-location]");
		s.dutyLocation = null;
		form.onchange();
		refresh.disabled = true;
		form.querySelector("[data-duty-location]").textContent = "Fetching your current location…";
		try {
			const point = await gps();
			if (!form.isConnected) return;
			s.dutyLocation = point;
			await showDutyLocation(form, point);
		} catch (e) {
			if (form.isConnected) {
				form.querySelector("[data-duty-location]").textContent = e.message;
				error(e);
			}
		} finally {
			if (form.isConnected) {
				refresh.disabled = false;
				refresh.hidden = false;
				refresh.textContent = "Refresh Location";
				form.onchange();
			}
		}
	}
	function bind() {
		bindHistoryFilters();
		root.querySelectorAll("[data-meter-photo]").forEach((button) => {
			button.onclick = () => {
				const label = button.dataset.meterLabel;
				modal(
					esc(label),
					`<img class="meter-photo-preview" src="${esc(
						button.dataset.meterPhoto
					)}" alt="${esc(label)}">`
				);
			};
		});
		root.querySelectorAll("[data-action]").forEach(
			(b) => (b.onclick = () => run(actions[b.dataset.action]))
		);
		root.querySelectorAll("[data-delete-visit]").forEach((button) => {
			button.onclick = () => run(() => deletePendingVisit(button.dataset.deleteVisit));
		});
		const form = root.querySelector("#duty-form");
		if (form) {
			const dutyRequestKey = uid();
			let selectedVehicle = form.elements.vehicle.value;
			const camera = bindOdometerCamera(
				form,
				"start",
				() => ({
					vehicle_number: form.elements.vehicle.value,
					request_key: dutyRequestKey,
				}),
				() => form.onchange()
			);
			const vehicleDialog = form.parentElement.querySelector("#vehicle-dialog");
			form.onchange = () => {
				if (selectedVehicle !== form.elements.vehicle.value) {
					selectedVehicle = form.elements.vehicle.value;
					camera.reset();
				}
				const selected = s.profile.vehicles?.[0];
				form.querySelector("#start-duty").disabled =
					!s.dutyLocation ||
					!form.elements.vehicle.value ||
					selected?.validation_error ||
					!form.elements.odometer_reading.checkValidity() ||
					!camera.valid();
			};
			form.onsubmit = (e) => {
				e.preventDefault();
				run(async () => {
					if (!camera.valid())
						throw Error("Capture the starting meter photo before Duty ON.");
					const data = new FormData(form);
					const point = await gps();
					await showDutyLocation(form, point);
					await api("duty_on", {
						vehicle_number: data.get("vehicle"),
						start_location: "Current Location",
						gps: point,
						request_key: dutyRequestKey,
						odometer_start: data.get("odometer_reading"),
						odometer_photo: camera.photo,
					});
					history.replaceState(null, "", location.pathname + location.search);
					await load();
				});
			};
			form.querySelector("[data-refresh-location]").onclick = () => fetchDutyLocation(form);
			form.querySelector("[data-add-vehicle]").onclick = () => vehicleDialog.showModal();
			vehicleDialog.querySelectorAll("[data-cancel-vehicle]").forEach((button) => {
				button.onclick = () => vehicleDialog.close();
			});
			vehicleDialog.querySelector("#vehicle-form").onsubmit = (event) => {
				event.preventDefault();
				run(async () => {
					if (!event.target.reportValidity()) return;
					const values = Object.fromEntries(new FormData(event.target));
					const result = await api("add_vehicle", { values });
					await load();
				});
			};
			fetchDutyLocation(form);
		}
	}
	window.addEventListener("hashchange", () => {
		if (s.busy) {
			s.pendingNavigation = true;
			return;
		}
		run(load);
	});
	window.addEventListener("pagehide", stopCamera);
	setInterval(tick, 30000);
	setInterval(() => {
		if (!active() || s.busy || s.stream || root.querySelector("dialog[open]")) return;
		run(
			async () => {
				const wasActive = active();
				s.data = await api("refresh_expenses", { duty: duty().name });
				if (wasActive !== active()) return load();
				root.querySelectorAll(".summary-cards .metric").forEach((card) => {
					if (card.querySelector("span")?.textContent === "Closing Balance")
						card.querySelector("strong").textContent = cashDisplay(
							s.data.available_cash
						);
				});
				const cost = root.querySelector("[data-fuel-cost]");
				if (cost) cost.textContent = money(s.data.fuel_reimbursement || 0);
				const night = root.querySelector("#night-stay");
				if (night) {
					night.outerHTML = nightStaySection();
					root.querySelectorAll("#night-stay [data-action]").forEach((button) => {
						button.onclick = () => run(actions[button.dataset.action]);
					});
				}
				const section = root.querySelector("#dsr-expenses");
				if (section) {
					section.outerHTML = expensesSection();
					root.querySelector('#dsr-expenses [data-action="expense"]').onclick = () =>
						run(addExpense);
				}
			},
			{ loading: false }
		);
	}, 60000);
	if (window.smart_dsr_user === "Guest") {
		root.innerHTML =
			'<main class="dsr-main"><section class="panel"><h1>SRV Electricals · Smart DSR</h1><p>Sign in with the email and password of your existing ERPNext User account.</p><a class="button primary" href="/login?redirect-to=/app/smart-dsr">Sign in</a></section></main>';
		return;
	}
	run(async () => {
		try {
			await load();
		} catch (e) {
			root.innerHTML = `<main class="dsr-main"><section class="panel"><h1>Smart DSR</h1><p>Signed in as <strong>${esc(
				window.smart_dsr_user
			)}</strong></p><p id="dsr-error" role="alert">${esc(
				e.message
			)}</p><p>Use the email and password of your enabled ERPNext User account. Each browser uses its own login session.</p><div class="actions">${button(
				"Sign out and switch account",
				"logout"
			)}<a class="button" href="/app/smart-dsr">Retry</a><a class="button" href="/app">ERPNext</a></div></section></main>`;
			bind();
			throw e;
		}
	});
})();
