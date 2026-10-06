# Changelog

Notable changes to **Light Bridge Studio**, newest first. Dates use Pacific time.

## 2026-10-05 — One yard, one show

Multiple flood sets now share a single timeline and layout. Device discovery lives in Settings, and a paired tablet view lets you arrange lights while standing in the yard.

### Added

- **Shows across multiple flood sets.** Bind up to 16 H7062 controllers to one show, with six independent tracks per controller—up to 96 flood heads. Existing six-track shows remain compatible.
- **A shared light layout.** Add discovered lights by model and position each fixture. H7062 heads receive animation tracks; other lights receive placement and their available device controls.
- **Settings → Lights.** LAN and Govee account discovery merge into one inventory, including cloud-only devices. A compact **Manage lights** shortcut keeps the main workspace focused on the layout and timeline.
- **Capability-based controls.** Power, brightness, RGB, white temperature, segments, toggles, music modes, and scenes appear when the device advertises compatible controls. Read-only or unavailable functions are identified explicitly.
- **Device scene discovery.** Load available scenes and existing DIY scenes from the connected Govee account.
- **iPad yard setup.** A touch-friendly page supports fixture selection and drag placement, with saved positions shared with the desktop. Project identity and revision checks protect against stale placement edits.
- **QR pairing.** Scan a locally generated QR code to open the tablet view. Choose a network address when needed; pairing expires after eight hours and can be disabled from the desktop.
- **Persistent Identify mode.** Starting the mode stops playback and darkens all added LAN lights. Selecting a fixture illuminates only that head or device and keeps it on until another is selected or the mode exits. Exit restores saved controller states.
- **Expanded MCP access.** Agents can inspect device capabilities, control devices, load scenes, add flood controllers to shows, read and move layout fixtures, and enter or exit Identify mode.

### Fixed

- Selecting a track, clicking a keyframe, editing a transition, or using Undo no longer resets the timeline scroll position.
- Adding a flood controller preserves existing light placements.
- Direct device commands cannot override controllers actively playing a show. Unrelated device controls leave flood playback alone.
- Playback and manual controls cannot override Identify mode. Rapid taps during identification no longer select a different fixture from the one being illuminated.
- Generic device commands invalidate stale cached flood colors.
- Bound multi-controller shows use local per-light playback rather than the incompatible single-track group output.

### Compatibility notes

- Synchronized timeline animation currently targets **H7062 flood controllers**. Other models use their advertised direct controls and device scenes; adding them to the layout does not imply timeline animation support.
- Bluetooth-only devices absent from both LAN discovery and Govee's developer API cannot be discovered here. API coverage and capabilities vary by model.
- Identify mode requires LAN access to every added light so it can darken the complete layout. Govee does not report individual starting head colors, so restoration uses the controller's reported state.
- Tablet pairing runs on the local network. The link grants setup access; QR generation does not send it to an external service.
- Shows are stored and played by Light Bridge. Saving a show does **not** upload it as a standalone hardware preset.

**Verification:** both H7062 sets were physically confirmed playing a 12-light show; Identify mode was physically confirmed to leave one flood on and the other eleven dark. Gaming-bar brightness was tested with device readback and restored. Larger controller counts are software-validated, not a claim of a 96-light hardware test.

[View this update's commits](https://github.com/throb/govee-controller/compare/0653cc3...72e6cc9)

## 2026-10-04 — First public studio

The first release brought visual show authoring, local playback, and agent control into one local web app.

### Added

- Basic color, intensity, and power controls with a movable stage layout.
- A keyframe editor for on/off state, intensity, and RGB color, with linear interpolation and held/jump transitions.
- Multi-key selection, group movement, copying between tracks, track clearing, and keyframe deletion.
- Editor-style transport controls, looping, seeking, previous/next key navigation, Undo, and Redo.
- Timeline color and intensity gradients, duration controls, and zoom-to-fit.
- Optional audio import, waveform display, beat markers, and beat-driven pattern generation. Audio is not required for animation.
- Named shows stored on disk, plus JSON import and export.
- A built-in MCP server and agent guide for creating, validating, saving, and playing shows.
- Settings sections for API credentials and copyable MCP configuration. API keys are stored locally using Windows encryption and excluded from project exports.
- Server-instance checks to prevent stale tabs from writing to a different installation.

### Fixed

- Audio import remains available during live playback.

[View the initial release commits](https://github.com/throb/govee-controller/compare/1608bbc...0653cc3)
