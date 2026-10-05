# Feature requests

## Support additional Govee lights and multiple controllers

Requested: 2026-10-04
Status: Backlog - deferred by user

### Goal

Discover and control supported Govee devices beyond the H7062 floods, including RGBIC gaming bars and other lights, without requiring users to type model numbers or relying on this installation's device addresses.

### Scope

- Discover actual devices and identify their models and capabilities from device/API responses.
- Provide a device picker and let users add multiple controllers to their layout.
- Build controls and timeline tracks from supported capabilities: whole-device RGB, brightness, power, and independent segments where available.
- Route commands through a model-specific adapter, using verified protocols. Do not send H7062 effect packets to other models.
- Support one show spanning multiple devices, with explicit timing and update-rate limitations for each transport.
- Persist device mappings locally and reconnect without hardcoded IP addresses.
- Expose supported devices, capabilities, and target selection through MCP, with README and agent-guide documentation.
- Identify unsupported or partially supported devices clearly rather than presenting controls that cannot work.

### Acceptance criteria

- A new installation discovers and lists supported devices without manual model entry or preloaded installation addresses.
- At least one additional model is verified on physical hardware for each advertised control capability.
- Multiple devices can be placed independently and addressed without changing untargeted lights.
- Saved shows retain device mappings across restart; missing devices show as unavailable without silently remapping tracks.
- Existing H7062 basic control and animation remain functional.
- Unit tests cover capability mapping and command routing; independent browser checks cover discovery, selection, and layout; hardware observations verify output.

This request schedules no work or notifications. Implementation is deferred until requested.

## Full app control through MCP

Requested: 2026-10-04
Status: Backlog - required product direction

### Goal

Every user-facing app workflow must have an equivalent documented MCP operation so an agent can operate the complete app without browser automation or one-off scripts. MCP coverage is a requirement for new features, including additional device support.

### Required coverage

- Onboarding, connection diagnostics, discovery, device selection, capability inspection, and connection configuration.
- Basic power, color, brightness, individual heads/segments, groups, and multiple devices.
- Layout creation and editing: add/remove supported fixtures, name, position, and map tracks to physical devices.
- Timeline creation and editing: duration, keyframes, transitions, multi-key selection/movement, copy/paste across tracks/devices, clearing, undo, and redo.
- Playback: preview, play, pause, stop, seek, looping, and authoritative playback/error status.
- Show library: create, list, inspect, save, rename, duplicate, load, import, export, and supported deletion workflows.
- Audio import and removal, audio metadata, waveform/beat analysis, beat editing, tempo grids, and pattern generation.
- Native device effects and preset operations wherever the hardware and verified protocol support them. Clearly report unsupported operations.
- Settings, connection setup, and persistence status. Credential setup must use a secure input mechanism; tools must never return existing API keys or put credentials in ordinary logs or exported shows.
- Editor/agent synchronization so agent changes are visible without losing unsaved user edits or silently replacing the active show.

### Implementation requirements

- Use the same validated application operations for UI and MCP; avoid separate behavior that drifts between interfaces.
- Publish discoverable tool schemas, capability descriptions, resources, examples, and README/agent-guide documentation.
- Distinguish read-only inspection, authoring, persistence, and physical-output actions. Creating or inspecting a show must not start playback.
- Provide actionable structured errors, current state, and operation outcomes. Network command acceptance must not be described as physical confirmation.
- Keep local files and credentials within explicit application-controlled boundaries; broad filesystem or shell access is not a substitute for proper app tools.

### Acceptance criteria

- Maintain a UI-to-MCP coverage matrix; every app action is supported or has a concrete documented blocker and status.
- A fresh agent can discover devices, configure a layout, author and edit a show, save/load it, and control playback using only documented MCP tools.
- Audio-assisted authoring and cross-device editing are exercised end to end when those features are supported.
- Test round trips, invalid input, persistence after restart, concurrent UI/agent edits, and recovery from disconnected devices.
- Verify physical-output tools on hardware separately from protocol and UI tests.

Existing MCP tools cover part of this scope. This request records the required expansion; it does not claim full coverage is implemented.
