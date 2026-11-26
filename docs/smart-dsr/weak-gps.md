# Weak-signal location tracking

The browser keeps a high-accuracy location watch during duty. If it times out or reports approximate coordinates, a second network-assisted watch starts. Both watches stop when duty ends. Fresh device timestamps are preserved; fixes older than one minute are not uploaded, and denied permission is not bypassed.

Live coordinates and their accuracy are shown on the duty card. GPS samples continue to retain their actual accuracy and verification state. A network-assisted fix is approximate and cannot guarantee an exact route.

Verified kilometres remain the source for fuel reimbursement. Estimated tracked kilometres add conservative displacement for approximate samples up to 1,000 metres accuracy. Estimated movement subtracts both endpoint accuracy radii and rejects excessive speeds, stale gaps and movement within the uncertainty area. It is a displacement estimate, not a reconstruction of the travelled road route. Very weak fixes can update location without adding distance. Tracking still requires an open, active browser and device location permission.

# Vehicle allocations

Administrator selects an allocated salesperson when creating or editing a vehicle. Salesperson-created vehicles are assigned to their signed-in account. Each salesperson has one current vehicle; assigning another clears their previous allocation without changing old DSR vehicle snapshots. Existing vehicles need an allocation before use. Duty ON checks allocation on the server. A vehicle used by another salesperson's active duty cannot be reassigned.

## Location required while duty is ON

The salesperson sees a persistent warning when location permission is revoked or the device stops providing location. Permission revocation is detected immediately where the browser Permissions API is available; location-watch errors cover other browsers. Temporary high-accuracy failures do not raise this warning while fresh network-assisted readings continue.

The warning explains that location must remain enabled while duty is ON and provides Retry Location. It records an interruption once per warning episode, stays visible across Smart DSR views, and clears on successful location upload or Duty OFF. This is an application warning: a website cannot lock the phone’s Location switch or prevent revoking browser permission.
