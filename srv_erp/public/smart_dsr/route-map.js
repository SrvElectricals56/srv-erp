/* Display recorded observations; never infer roads or change reimbursement distance. */
(() => {
	"use strict";
	const markup = () =>
		`<section class="dsr-route-section"><div class="dsr-route-toolbar"><h3>Travelled Route</h3><button type="button" data-route-refresh>Refresh Route</button><button type="button" data-route-fit>Show Full Route</button></div><p data-route-status role="status">Loading recorded GPS route…</p><div class="dsr-route-map" data-route-map role="region" aria-label="Salesperson travelled route map"></div><div class="dsr-route-legend"><span>Verified travel</span><span class="approximate">Approximate travel</span><span class="gap">Gaps are not connected</span></div><p class="hint">Recorded GPS points show the observed journey, not an exact road route. Green: start · Purple: dealer stops · Red: end · Blue: latest location. Active duties refresh every 30 seconds.</p><p class="hint" data-route-tiles></p></section>`;
	function mount(dialog, fetchRoute) {
		const section = dialog.querySelector(".dsr-route-section");
		const canvas = section.querySelector("[data-route-map]");
		const status = section.querySelector("[data-route-status]");
		let map,
			layers,
			bounds,
			timer,
			resizeObserver,
			loading = false,
			disposed = false,
			fitted = false;
		const date = (value) => {
			if (!value) return "—";
			const stamp = new Date(String(value).replace(" ", "T"));
			if (Number.isNaN(stamp.getTime())) return String(value);
			return (
				stamp
					.toLocaleDateString("en-GB", {
						timeZone: "Asia/Kolkata",
						day: "2-digit",
						month: "2-digit",
						year: "2-digit",
					})
					.replaceAll("/", "-") +
				", " +
				stamp.toLocaleTimeString("en-IN", {
					timeZone: "Asia/Kolkata",
					hour: "2-digit",
					minute: "2-digit",
					hour12: true,
				})
			);
		};
		const popup = (text) => {
			const node = document.createElement("div");
			node.textContent = text;
			return node;
		};
		function cleanup() {
			if (disposed) return;
			disposed = true;
			clearInterval(timer);
			resizeObserver?.disconnect();
			if (map) {
				map.stop();
				map.remove();
			}
			dialog.removeEventListener("close", cleanup);
		}
		dialog.addEventListener("close", cleanup);
		dialog.routeCleanup = cleanup;
		const fit = () => {
			if (bounds?.isValid()) {
				map.invalidateSize();
				map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16, animate: false });
			}
		};
		section.querySelector("[data-route-fit]").onclick = fit;
		async function refresh() {
			if (disposed || loading) return;
			if (!section.isConnected || !dialog.open) return cleanup();
			loading = true;
			const button = section.querySelector("[data-route-refresh]");
			button.disabled = true;
			try {
				if (!window.L) throw Error("Map library unavailable. Reload this page to retry.");
				const data = await fetchRoute();
				if (disposed || !section.isConnected) return;
				const points = data.points || [],
					visits = data.visits || [];
				status.textContent = `${points.length} GPS points · ${
					visits.length
				} dealer stops · ${(data.gaps || []).length} tracking gaps · Verified: ${Number(
					data.verified_km || 0
				).toFixed(2)} KM · Estimated: ${Number(
					data.estimated_km ?? data.verified_km ?? 0
				).toFixed(2)} KM${
					points.length
						? " · Latest GPS: " + date(points[points.length - 1].captured_at)
						: " · No GPS route recorded for this duty"
				}`;
				if (!points.length && !visits.length) {
					canvas.hidden = true;
					if (layers) layers.clearLayers();
				} else {
					canvas.hidden = false;
					if (!map) {
						map = L.map(canvas, {
							preferCanvas: false,
							scrollWheelZoom: false,
							trackResize: false,
							zoomAnimation: false,
							fadeAnimation: false,
							markerZoomAnimation: false,
							inertia: false,
						}).setView([22.5, 79], 5);
						L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
							maxZoom: 19,
							attribution:
								'&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
						})
							.on("tileerror", () => {
								section.querySelector("[data-route-tiles]").textContent =
									"Some background map tiles could not load. The recorded route remains visible.";
							})
							.addTo(map);
						layers = L.layerGroup().addTo(map);
						if (window.ResizeObserver) {
							resizeObserver = new ResizeObserver(() => {
								if (!disposed && canvas.isConnected)
									map.invalidateSize({ animate: false, pan: false });
							});
							resizeObserver.observe(canvas);
						}
					}
					layers.clearLayers();
					bounds = L.latLngBounds([]);
					points.forEach((point) => bounds.extend([point.latitude, point.longitude]));
					for (const segment of data.segments || []) {
						L.polyline(segment.coordinates, {
							color: segment.kind === "verified" ? "#2563eb" : "#d97706",
							weight: 4,
							dashArray: segment.kind === "verified" ? null : "7 7",
						})
							.bindPopup(
								popup(
									`${
										segment.kind === "verified" ? "Verified" : "Approximate"
									} travel: ${date(segment.started_at)} → ${date(
										segment.ended_at
									)}`
								)
							)
							.addTo(layers);
					}
					const marker = (point, color, text, radius = 7) =>
						L.circleMarker([point.latitude, point.longitude], {
							radius,
							color: "#fff",
							weight: 2,
							fillColor: color,
							fillOpacity: 1,
						})
							.bindPopup(popup(text))
							.addTo(layers);
					for (const [index, visit] of visits.entries()) {
						if (visit.latitude == null || visit.longitude == null) continue;
						bounds.extend([visit.latitude, visit.longitude]);
						marker(
							visit,
							"#7c3aed",
							`Dealer stop ${index + 1}: ${visit.customer} · ${date(
								visit.arrived_at
							)} → ${date(visit.departed_at)} · ${visit.status}`
						);
					}
					for (const gap of data.gaps || [])
						marker(
							gap,
							"#64748b",
							`${gap.reason}: ${date(gap.from)} → ${date(gap.to)}`,
							4
						);
					if (points.length) {
						const first = points[0],
							last = points[points.length - 1];
						marker(
							first,
							"#16a34a",
							`First recorded location · ${date(
								first.captured_at
							)} · Accuracy ±${Math.round(first.accuracy)} m`,
							9
						);
						marker(
							last,
							data.status === "Active" ? "#2563eb" : "#dc2626",
							`${
								data.status === "Active" ? "Latest" : "Last recorded"
							} location · ${date(last.captured_at)} · Accuracy ±${Math.round(
								last.accuracy
							)} m`,
							8
						);
						L.circle([last.latitude, last.longitude], {
							radius: Math.min(Number(last.accuracy), 5000),
							color: "#64748b",
							weight: 1,
							fillOpacity: 0.08,
						}).addTo(layers);
					}
					if (!fitted) {
						fit();
						fitted = bounds.isValid();
					} else map.invalidateSize();
				}
				if (data.status !== "Active") clearInterval(timer);
			} catch (error) {
				if (!disposed)
					status.textContent = `Route could not be loaded: ${error.message}. Use Refresh Route to retry.`;
			} finally {
				loading = false;
				if (!disposed) button.disabled = false;
			}
		}
		section.querySelector("[data-route-refresh]").onclick = refresh;
		timer = setInterval(refresh, 30000);
		refresh();
		return cleanup;
	}
	window.SmartDSRRoute = { markup, mount };
})();
