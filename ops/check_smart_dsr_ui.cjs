// Current Smart DSR workflow checks. The former website entry now redirects to Desk.
const { execFileSync } = require("child_process");
const path = require("path");

for (const script of [
  "check_smart_dsr_user_login_ui.cjs",
  "check_smart_dsr_duty_location.cjs",
  "check_smart_dsr_odometer.cjs",
  "check_smart_dsr_photo_first.cjs",
]) {
  execFileSync(process.execPath, [path.join(__dirname, script)], {
    stdio: "inherit",
    env: process.env,
    timeout: 60000,
  });
}
console.log(
  "PASS: current login, metrics, duty location, meter camera and photo-first visit workflows. Isolated API/GPS/camera fixtures."
);
