# Administrator route map

Open **Smart DSR Administrator → Duty Records → View / Manage → Travelled Route**. Linked Smart DSR records also show this map in their duty detail window.

The map shows all retained GPS points from Duty ON through Duty OFF, rather than only the first page of the GPS audit table. The scoped administrator endpoint restricts both the duty and its GPS/visit records to the existing report permissions.

- Blue lines: verified GPS travel.
- Dashed orange lines: approximate observed travel.
- Grey markers: gaps, implausible jumps or very imprecise readings. These intervals are not joined.
- Green marker: first recorded location.
- Purple markers: dealer visits; click for the dealer and arrival/departure times.
- Blue/red final marker: latest location on an active duty / last recorded location on an ended duty.

Use **Show Full Route** to reset the viewport or **Refresh Route** to update manually. Active duties refresh automatically every 30 seconds while the detail window remains open. Closing the window releases the map and its refresh timer. Duties without retained GPS readings show an empty-route message.

The map uses the locally packaged Leaflet library and attributed OpenStreetMap background tiles. Background tiles need network access. Popup text is rendered as text, not HTML. The route connects observed locations; it does not reconstruct exact roads or invent missing tracking. Map rendering does not change verified distance, fuel reimbursement or reward calculations.
