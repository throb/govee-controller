# Timeline playback in the app

Open http://127.0.0.1:8765/#advanced. Output defaults to **Individual heads · Local animation**. Edit the six tracks and press **Play**. **Loop** repeats; **Stop** restores the starting controller color, power, and brightness (not a prior per-head pattern or device effect).

The host evaluates on/off, RGB, intensity, linear interpolation and held/jump transitions, then uploads a six-color stationary effect frame over LAN at up to 10 Hz. The computer/server must remain running. This is not a standalone timeline saved into the controller, and Home Assistant is not connected to this playback path.

Hardware verification: the user confirmed only Flood 1 alternated green/blue every two seconds while five heads remained dark. Other head ordering and smooth fades still need physical verification. Software tests check intensity/off encoding and packet framing. UDP transmission is not a hardware acknowledgement.

## Earlier palette experiment

# Verified H7062 custom effect

Cyan Amber Flow was generated in Python, sent directly to the H7062 over LAN, and physically confirmed by the user. The cyan-only diagnostic also confirmed that palette changes were accepted.

This authors a new palette using the H7062 Rainbow motion template. It does not create a Govee cloud DIY entry and does not yet compile arbitrary keyframe timelines. The controller runs the animation after one upload; there are no recurring cloud frame updates.

## Generate an effect

```powershell
python effect_lab.py --colors 00ffff ff6400 --name "Cyan Amber Flow" --output effects/my_flow.json
```

Supply one to six RGB hex colors. Fewer than six colors repeat across the six palette slots.

## Generate and apply

Add `--send-to YOUR_FLOOD_IP` to the command. The IP is the controller's LAN address. LAN Control must be enabled.

The final activation packet is required in the tested setup. The earlier A1 DIY format did not work; the verified path is the multipart A3 parameter upload followed by activation.

`effects/cyan_amber_flow.json` records the verified palette and encoded commands without API credentials or a device address. Newly generated effects are marked unverified until physically checked.

## Home Assistant

This test succeeded directly from the PC. Home Assistant integration has not been installed or verified; its built-in LAN discovery found no devices. The same LAN payload can be reused once network reachability from that host is established.

Packet framing references: govee2mqtt src/ble.rs and AlgoClaw/Govee decoded/v1.2. See THIRD_PARTY_NOTICES.txt.
