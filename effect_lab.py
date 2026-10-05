"""H7062 palette upload verified; arbitrary timeline encoding is experimental.
Packet framing follows the MIT-licensed govee2mqtt SetSceneCode implementation.
"""
import argparse
import base64
import functools
import json
import math
import operator
import socket
from pathlib import Path

# H7062 Rainbow motion parameters, fetched from Govee's model effect catalog.
TEMPLATE = "ASkAAAAGAgHnnwEAFBQD6goG/w8H/38A//8AAP8AAP//AAD/EAD0AACAAw=="

def decode_effect(parameters):
    """Inspect sceneType-2 blocks without assigning unverified timing units.

    Format reference: algrym/govee-ble-h617a govee_scene_speed.py.
    Implemented independently from the published field layout.
    Effect segments are not necessarily physical flood heads.
    """
    data = bytes(parameters)
    if not data or not data[0]:
        raise ValueError("Missing effect segments")
    offset = 1
    result = []
    for _ in range(data[0]):
        if offset >= len(data):
            raise ValueError("Missing segment")
        end = offset + data[offset] + 1
        block = data[offset:end]
        if end > len(data) or len(block) < 18:
            raise ValueError("Truncated effect segment")
        color_start = 7 + 6 * block[6]
        if color_start + 4 > len(block):
            raise ValueError("Truncated brightness blocks")
        movement_start = color_start + 4 + 3 * block[color_start + 3]
        if movement_start + 7 != len(block):
            raise ValueError("Invalid color count or segment length")
        result.append({
            'header': list(block[:7]),
            'brightness': [list(block[i:i+6]) for i in range(7, color_start, 6)],
            'colorControl': list(block[color_start:color_start+4]),
            'colors': [list(block[i:i+3]) for i in range(color_start+4, movement_start, 3)],
            'movementWithinArea': list(block[movement_start:movement_start+3]),
            'movementBetweenAreas': list(block[movement_start+3:]),
        })
        offset = end
    if offset != len(data):
        raise ValueError("Unexpected trailing effect bytes")
    return result

def finish(data):
    if len(data) > 19:
        raise ValueError("Packet payload exceeds 19 bytes")
    data = bytes(data).ljust(19, b"\0")
    return data + bytes([functools.reduce(operator.xor, data)])

def encode_timeline_frame(colors):
    """Experimental six-slot static frame; physical head mapping is unverified.

    Uses the catalog Star color selector with Rainbow's steady brightness.
    Disables internal movement so the host timeline supplies animation timing.
    """
    if (not isinstance(colors, list) or len(colors) != 6
            or any(not isinstance(rgb, list) or len(rgb) != 3
                   or any(type(c) is not int or not 0 <= c <= 255 for c in rgb)
                   for rgb in colors)):
        raise ValueError('A frame needs six RGB colors with integer channels 0–255')
    parameters = bytearray(base64.b64decode(TEMPLATE))
    parameters[3] = 1
    parameters[14:18] = bytes([3, 0, 0, 6])
    parameters[18:36] = bytes(c for rgb in colors for c in rgb)
    parameters[36:43] = bytes(7)
    return encode_parameters(parameters)

def encode_parameters(parameters, code=2598):
    body = bytes([2]) + bytes(parameters)
    count = math.ceil((len(body) + 2) / 17)
    if count > 255:
        raise ValueError("Effect is too large")
    body = bytes([1, count]) + body
    frames = [finish(bytes([0xa3, 255 if i == count - 1 else i]) + body[i*17:(i+1)*17]) for i in range(count)]
    frames.append(finish([0x33, 5, 4, code & 255, code >> 8]))
    return [base64.b64encode(frame).decode() for frame in frames]

def make_effect(colors, name):
    if not 1 <= len(colors) <= 6:
        raise ValueError("Choose 1 to 6 colors")
    palette = []
    for color in colors:
        color = color.removeprefix("#")
        if len(color) != 6:
            raise ValueError("Colors must have six hexadecimal digits")
        palette.append(list(bytes.fromhex(color)))
    palette = [palette[i % len(palette)] for i in range(6)]
    parameters = bytearray(base64.b64decode(TEMPLATE))
    if len(parameters) != 43 or parameters[17] != 6:
        raise ValueError("Unexpected motion template")
    parameters[18:36] = bytes(c for rgb in palette for c in rgb)
    return {"name": name, "model": "H7062", "palette": palette,
            "motionTemplate": "Rainbow", "verified": False,
            "command": encode_parameters(parameters)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--colors", nargs="+", required=True)
    parser.add_argument("--name", default="Custom Flow")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--send-to", help="Explicit flood IP; omit to generate only")
    args = parser.parse_args()
    effect = make_effect(args.colors, args.name)
    args.output.write_text(json.dumps(effect, indent=2), encoding="utf-8")
    if args.send_to:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.sendto(json.dumps({"msg": {"cmd": "ptReal", "data": {"command": effect["command"]}}}).encode(), (args.send_to, 4003))
        print("Effect transmitted; physical playback must be verified.")
    else:
        print("Effect generated without sending light commands.")

if __name__ == "__main__":
    main()
