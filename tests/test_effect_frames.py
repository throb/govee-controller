"""Software framing checks; these do not certify physical head mapping."""
import base64
import functools
import operator
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from effect_lab import encode_timeline_frame, decode_effect
from animation import evaluate, rgb_output


class EffectFrameTests(unittest.TestCase):
    def test_timeline_intensity_and_off_survive_packetization(self):
        keys = [dict(t=0, on=True, intensity=100, color=[0, 200, 0], ease='linear'),
                dict(t=2, on=True, intensity=10, color=[0, 200, 0], ease='jump')]
        off = [dict(t=0, on=False, intensity=100, color=[255, 255, 255], ease='jump')]
        project = dict(tracks=[dict(keys=keys)] + [dict(keys=off) for _ in range(5)])
        colors = [rgb_output(s) for s in evaluate(project, 1)]
        packets = [base64.b64decode(p) for p in encode_timeline_frame(colors)]
        for packet in packets:
            self.assertEqual(len(packet), 20)
            self.assertEqual(functools.reduce(operator.xor, packet), 0)
        self.assertEqual(packets[-1][:5], bytes([0x33, 5, 4, 0x26, 0x0a]))
        body = b''.join(p[2:19] for p in packets[:-1])
        self.assertEqual(body[:3], bytes([1, 3, 2]))
        decoded = decode_effect(body[3:46])[0]
        self.assertEqual(decoded['colors'], [[0, 110, 0]] + [[0, 0, 0]] * 5)
        self.assertEqual(decoded['movementWithinArea'], [0, 0, 0])
        self.assertEqual(decoded['movementBetweenAreas'], [0, 0, 0, 0])

    def test_reject_invalid_frame(self):
        for colors in ([], [[0, 0, 0]] * 5, [[-1, 0, 0]] * 6, [[True, 0, 0]] * 6):
            with self.assertRaises(ValueError):
                encode_timeline_frame(colors)
