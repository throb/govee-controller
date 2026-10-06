# Light Bridge MCP — agent guide

## Connect

Start Light Bridge with `python launch.py`. Configure your MCP client to launch `mcp_server.py` using Python 3.12 and stdio. No extra packages or API key in the MCP configuration are needed. The bridge only accesses the existing app at http://127.0.0.1:8765. It does not launch a second light controller. Run the MCP script from the same installation as the server: writes to a different installation are rejected, and each request carries the current server-instance token.

Example MCP client JSON (replace paths on other computers):

```json
{"mcpServers":{"light-bridge":{"command":"C:/path/to/python.exe","args":["C:/path/to/govee-controller/mcp_server.py"]}}}
```

For Codex, the equivalent configuration is:

```toml
[mcp_servers.light-bridge]
command = "C:/path/to/python.exe"
args = ["C:/path/to/govee-controller/mcp_server.py"]
```

These are portable configuration examples: replace the paths with your installation. Existing sessions may need reconnecting or restarting before discovering newly registered tools. Restart/reconnect the client after configuring it. The stdio process must keep stdout reserved for JSON-RPC.

## Workflow

1. Read `lighting_capabilities` and resource `lightbridge://guide`.
2. Use `lighting_discover` to scan controllers. Only H7062 sets can play these timelines; discovery does not make other models valid targets. Add discovered controller IDs with `show_add_controller`.
3. Use `show_create` with name and duration, or `show_get` to read an existing saved show. Omitting id reads the editor autosave without modifying it.
4. Build each track with `show_set_track`. Each returned document is the input to the next edit. These operations do not save or alter physical lights.
5. `show_validate` checks the complete show and evaluates all output states at a chosen time. Inspect starts, transitions and loop boundary.
6. `show_save` saves a new named show when id is omitted. Supply an existing id only to intentionally replace that saved show. Save returns its id. The editor working copy remains unchanged. Reopen the Saved shows list by reloading the editor to see externally saved entries.
7. Only when playback is requested, `show_play` with the saved id and explicit loop setting starts physical output. It replaces current playback. Read `lighting_status`; `lighting_stop` stops it. `lighting_loop` changes looping; disabling finishes the current pass.

## Show schema

A show has `version:1`, `name`, `duration` (0.1–3600 seconds), and `tracks`. Legacy shows without `controllers` have exactly six tracks. Multi-set shows have `controllers:[{id,model:"H7062",name?}]` and six contiguous tracks per controller, in the same order. Up to 16 unique controllers / 96 tracks are allowed. Indices 0–5 belong to the first set, 6–11 to the second, and so on. Each track contains `name` and `keys`. Each track must have a key at time zero and distinct ascending times within duration. Maximum 5,000 keys per track and 12,000 per show.

Every key has:

- `t`: seconds.
- `on`: boolean. On/off changes at the key time.
- `intensity`: 0–100.
- `color`: integer RGB array, each channel 0–255.
- `ease`: `linear` interpolates RGB and intensity toward the next key; `jump` holds until the next key. This field belongs to the departing key.

Optional editor data (layout, audioRef, beats, waveform, loop, key ids) is preserved. Layout fixtures have x 5–95, y 8–92 and angle -180–180. Angles describe the visual layout, not motorized lights. Audio references point to files already imported on this computer; MCP does not import arbitrary file paths. Physical MCP playback is the light timeline; it does not play audio on the computer. Use the browser for audio playback.

Example track for a blue fade, amber hold, and Off:

```json
{"track":0,"keys":[
 {"t":0,"on":true,"intensity":10,"color":[0,80,255],"ease":"linear"},
 {"t":2,"on":true,"intensity":70,"color":[0,80,255],"ease":"jump"},
 {"t":4,"on":true,"intensity":35,"color":[255,100,0],"ease":"jump"},
 {"t":6,"on":false,"intensity":0,"color":[0,0,0],"ease":"jump"}
]}
```

Include the entire `project` returned by create/get in show_set_track arguments. For staggered scenes, give each track its own timed sequence. To loop seamlessly, match ending and starting values deliberately. Use layout positions from show_get to order a spatial chase instead of assuming track index equals physical position.

## Reality of playback

Shows live on this computer. The server streams frames at 10 Hz over LAN. This is NOT a device-stored preset, Govee DIY registration, or upload of an autonomous effect. The computer/server must stay running. Device preset upload is not available. UDP transmission/status is not proof of physical response. Six-head animation and sustained looping were physically verified on this installation; new scenarios still need observation when physical fidelity matters.

Stop restores the starting shared controller color, brightness and power, not the exact previous per-head scene. Existing API credentials stay encrypted in the app; MCP has no credential read/write tools. Authoring is side-effect-free until save or an explicit physical-control tool. Saved shows are not automatically synchronized into an already-open editor, preventing silent replacement of unsaved user edits.

Protocol references: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports and https://modelcontextprotocol.io/specification/2025-11-25/server/tools.

## Controller selection

Run `lighting_discover`, then `lighting_devices` to inspect every responding controller and the selected ID. Call `lighting_select_device` with an H7062 device `id` to select its six heads. Selection is saved and does not start playback. Stop playback before switching. Other discovered models are visible but not yet controllable; multi-controller timelines use explicit IDs in the show instead of this legacy selection.

## Add a set to a show

`show_add_controller` takes `project`, a discovered H7062 `id`, and optional `name`, returning an edited copy with six new Off tracks. For a legacy six-track show, also pass `existingDeviceId` to bind its original tracks. If the new ID equals that existing ID, the call only binds the original set. Duplicate IDs are rejected. Continue editing with `show_set_track` (indices 0–95, bounded by actual track count), validate, save, and play explicitly. All controllers share one playback clock; unavailable controllers prevent the start.

## All discovered Govee lights

Open **Settings → Lights** (or **Manage lights**). Find lights merges local LAN discovery with devices returned by your connected Govee account, deduplicated by device ID. No model-number entry is needed. Cloud-only devices are included. Each card opens device controls and state readback; H7062 sets also have Add to show.

Power, brightness, RGB, white temperature, toggles, segments, music settings, and scene options are generated from the advertised parameter schema. Load scenes / Load DIY scenes fetches device-specific options. Unknown or read-only schemas are visible but disabled. LAN is preferred for standard controls; other advertised controls use Govee's API. Cloud commands are rate-paced and are not a real-time animation transport. Input defaults are command values, not claims about current hardware state; use Read state.

Universal means capability-driven support, not a claim that every Govee product exposes every function: Bluetooth-only devices absent from both LAN and the developer API cannot be discovered here. Devices outside Govee's API coverage, proprietary pixel effects, and unadvertised functions remain unavailable. Non-light appliances are shown read-only. The synchronized multi-head timeline currently supports H7062 sets; other devices have direct controls and advertised device scenes.

Controls refuse to modify a controller actively playing the show. Unrelated device controls do not stop flood playback. LAN replies and API acceptance are not physical visual verification.

API: POST `/api/devices/refresh` merges discovery; GET `/api/devices` returns capability schemas. POST `/api/devices/state` with `{ "id": "device-id" }` reads state. POST `/api/devices/scenes` accepts `id` and optional `diy`. POST `/api/devices/control` accepts `id`, `type`, `instance`, and `value`, validated against the advertised schema. POST requests require the current `X-LightBridge-Instance` header. Keys stay in encrypted local storage.

MCP tools: `lighting_refresh_devices`, `lighting_devices`, `lighting_device_state`, `lighting_device_scenes`, `lighting_device_control`. Read the returned capability parameters first, then submit the exact type/instance and a valid value. Scene discovery updates the inventory with available choices. Example brightness command: `{ "id": "device-id", "type": "devices.capabilities.range", "instance": "brightness", "value": 40 }`.

References: [Govee device capabilities](https://developer.govee.com/reference/get-you-devices), [control](https://developer.govee.com/reference/control-you-devices), [state](https://developer.govee.com/reference/get-devices-status), [scenes](https://developer.govee.com/reference/get-light-scene).

## iPad yard setup and mixed-light placement

Settings → Lights → **Add lights** uses the discovered model: H7062 adds six physical flood heads with animation tracks; other models add a named device fixture to the shared layout with their available direct controls. Additional fixtures are stored in `layout.lights` and do not pretend to support H7062 animation packets. Drag any added fixture to place it; click a non-flood fixture for its controls.

Enable iPad setup in Settings → Lights to start a separate LAN-only setup service on port 8766. Open the generated pairing URL in Safari on an iPad on the same trusted Wi-Fi. The random token expires after 8 hours; enabling again rotates it, and Disable closes the listener. The URL grants layout movement, identification, and stopping playback only. It cannot read API credentials or access desktop settings. Keep the link private: local HTTP does not encrypt traffic. No router port forwarding is needed or intended. Windows Firewall or guest-network isolation may prevent connection; do not open this service to the internet.

On iPad: tap a light, pause the show if playing, choose Identify selected light, then drag the light to its location. Each LAN flood head is identified separately; other LAN lights identify as a whole device. Cloud-only identification is explicitly unavailable. Identification restores the controller's reported starting state; per-head starting colors cannot be recovered from Govee state readback. Layout writes are saved to disk and synced to desktop; stale concurrent moves are rejected. Tablet placement updates the autosave; use Save on desktop to update the named show.

MCP adds `lighting_layout`, `lighting_move_light` (requires the current projectId and revision), and `lighting_identify`. Physical identification is blocked during playback. Desktop-only POST `/api/tablet/enable` returns pairing URLs, and `/api/tablet/disable` revokes access.
