# Fresh-user onboarding check

Historical independent review, 2026-10-04. Preview-only playback described below was subsequently removed: Play now targets the physical lights. These results describe the build tested at the time, not a fresh verification of every current interaction.

## Passed

- Exported staged files into a disposable directory without existing data or credentials.
- Launched the app on isolated HTTP port 8876 with loopback LAN configuration. Actual Network implementation retained; no production hardware commands.
- Rendered Basic and Advanced in the browser.
- Played the included Chroma sweep in Preview without audio or lights.
- Saved a named show through Save as; reloaded and verified persistence and the saved-show dropdown.
- Launched launch.py from a different working directory. Browser auto-opening suppressed only in the test harness.
- Initialized MCP stdio, listed 12 tools, read saved-show listings, created six-track shows, and retrieved the guide resource.
- Saved an MCP-authored show and retrieved it with exact duration and track data preserved.
- Re-read corrected README instructions and formatting.
- Closed audit tabs and stopped the isolated server. Production show, data, credentials, and lights were not changed by the audit.

## Corrected

- README now describes the included Chroma sweep instead of implying a blank initial project.
- Added a hardware-free Preview walkthrough.
- Documented the API connection and visual calibration required for Basic single-head commands; distinguished this from local animation.
- Added Git/Python setup pointers and first-launch troubleshooting.
- Fixed README line endings so tables and code blocks render correctly.

## Still unverified

- Explicit browser Open-button roundtrip: the later browser connection disappeared and the fallback blocked the isolated localhost URL. Save/reload persistence and MCP save/get passed; do not substitute these for the missing click test.
- Physical discovery, first-time cloud connection/DPAPI storage, and playback on a different computer with real hardware.
- Installing Python and Git on a machine without development tools.
- UDP port contention recovery: startup currently depends on binding UDP 4002. A bind failure can prevent the preview server from starting; this was identified from code, not reproduced here.

This is a scoped onboarding check, not a claim of flawless behavior on all systems. Repeat the unverified hardware checks on a clean supported Windows installation before advertising a generally supported release.

## Follow-up: real fresh-install discovery

The clean copy with no network configuration now automatically discovers five Govee controllers, including the supported H7062, and reads its current shared state. Multi-interface multicast plus OS-learned-neighbor fallback is implemented in the server; no installation addresses are hardcoded. First-run API setup, inline validation, explicit skip, and empty disconnected stages were independently browser-checked. Virtual fixtures require an explicit preview choice. Python suite: 41 passing tests.

## Release cleanup verification

Independent browser check of the updated running app: live output is the default with only Each light and All lights choices; Save and Open preserve Chroma sweep; next/previous key navigation selects 4.000s/0.000s; the 4-second key shows 65% intensity in the inspector. Settings connection diagnostics expand correctly. Basic and Advanced layouts were visually inspected without horizontal overflow; fresh screenshots replace the earlier images. Chroma sweep was resumed through the Play button with Loop enabled. Timeline content was preserved.

The staged repository was exported without private data and passed all 47 Python and 7 JavaScript tests. Live MCP initialization and saved-show listing passed. Installing Python/Git on a separate clean machine remains outside this check.
