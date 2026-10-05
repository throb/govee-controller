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
2. Use `lighting_discover` to scan controllers. Only the configured H7062 six-head set can play these timelines; discovery does not make other models valid targets.
3. Use `show_create` with name and duration, or `show_get` to read an existing saved show. Omitting id reads the editor autosave without modifying it.
4. Build each track with `show_set_track`. Each returned document is the input to the next edit. These operations do not save or alter physical lights.
5. `show_validate` checks the complete show and evaluates its six output states at a chosen time. Inspect starts, transitions and loop boundary.
6. `show_save` saves a new named show when id is omitted. Supply an existing id only to intentionally replace that saved show. Save returns its id. The editor working copy remains unchanged. Reopen the Saved shows list by reloading the editor to see externally saved entries.
7. Only when playback is requested, `show_play` with the saved id and explicit loop setting starts physical output. It replaces current playback. Read `lighting_status`; `lighting_stop` stops it. `lighting_loop` changes looping; disabling finishes the current pass.

## Show schema

A show has `version:1`, `name`, `duration` (0.1–3600 seconds), and exactly six `tracks`. Track index 0 is Flood 1; index 5 is Flood 6. Each track contains `name` and `keys`. Each track must have a key at time zero and distinct ascending times within duration. Maximum 5,000 keys per track and 12,000 per show.

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
