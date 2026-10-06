"""Deterministic lighting timeline evaluation. No hardware side effects."""
import math

def number(value, low, high, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{label} must be between {low} and {high}')
    return float(value)

def validate_project(project):
    if not isinstance(project, dict) or project.get('version') != 1:
        raise ValueError('Unsupported project format')
    duration = number(project.get('duration'), .1, 3600, 'Duration')
    controllers = project.get('controllers')
    if controllers is not None:
        if not isinstance(controllers, list) or not 1 <= len(controllers) <= 16:
            raise ValueError('Project needs 1–16 controllers')
        ids = set()
        for controller in controllers:
            if not isinstance(controller, dict) or controller.get('model') != 'H7062' or not isinstance(controller.get('id'), str) or not controller['id'].strip() or len(controller['id']) > 200:
                raise ValueError('Invalid H7062 controller binding')
            if controller['id'] in ids: raise ValueError('Duplicate controller binding')
            ids.add(controller['id'])
    track_count = len(controllers) * 6 if controllers is not None else 6
    if 'layout' in project:
        layout = project['layout']
        fixtures = layout.get('fixtures') if isinstance(layout, dict) else None
        if not isinstance(fixtures, list) or len(fixtures) != track_count:
            raise ValueError('Layout must match the flood track count')
        for fixture in fixtures:
            if not isinstance(fixture, dict): raise ValueError('Invalid flood placement')
            number(fixture.get('x'), 5, 95, 'Flood X')
            number(fixture.get('y'), 8, 92, 'Flood Y')
            number(fixture.get('angle'), -180, 180, 'Flood aim')
    tracks = project.get('tracks')
    if not isinstance(tracks, list) or len(tracks) != track_count:
        raise ValueError('This H7062 project needs six flood tracks per controller')
    cleaned = []
    total = 0
    for i, track in enumerate(tracks):
        keys = track.get('keys') if isinstance(track, dict) else None
        if not isinstance(keys, list) or not keys or len(keys) > 5000:
            raise ValueError('Each track needs 1–5000 keyframes')
        checked = []
        for key in keys:
            if not isinstance(key, dict): raise ValueError('Invalid keyframe')
            t = number(key.get('t'), 0, duration, 'Keyframe time')
            level = number(key.get('intensity'), 0, 100, 'Intensity')
            if type(key.get('on')) is not bool: raise ValueError('On/off must be boolean')
            color = key.get('color')
            if not isinstance(color, list) or len(color) != 3: raise ValueError('Color must be RGB')
            color = [round(number(c, 0, 255, 'Color')) for c in color]
            if key.get('ease') not in ('linear', 'jump'): raise ValueError('Transition must be linear or jump')
            checked.append({'t': t, 'on': key['on'], 'intensity': level, 'color': color, 'ease': key['ease']})
        checked.sort(key=lambda k: k['t'])
        if any(abs(a['t'] - b['t']) < .000001 for a, b in zip(checked, checked[1:])):
            raise ValueError('Two keyframes cannot occupy the same time on a track')
        if checked[0]['t'] != 0: raise ValueError('Each track needs an initial keyframe at zero')
        cleaned.append({'name': str(track.get('name', f'Flood {i + 1}'))[:80], 'keys': checked})
        total += len(checked)
    if total > 12000: raise ValueError('Project exceeds 12000 keyframes')
    result = {'version': 1, 'name': str(project.get('name', 'Untitled'))[:120], 'duration': duration, 'tracks': cleaned}
    if controllers is not None:
        result['controllers'] = [{'id':c['id'], 'model':'H7062', 'name':str(c.get('name', 'Flood set'))[:80]} for c in controllers]
    return result

def evaluate_track(track, t):
    keys = track['keys']
    a = keys[0]
    b = None
    for key in keys[1:]:
        if key['t'] <= t: a = key
        else:
            b = key
            break
    fraction = 0
    if b and a['ease'] == 'linear':
        fraction = max(0, min(1, (t - a['t']) / (b['t'] - a['t'])))
    color = a['color'] if b is None else [a['color'][i] + (b['color'][i] - a['color'][i]) * fraction for i in range(3)]
    level = a['intensity'] if b is None else a['intensity'] + (b['intensity'] - a['intensity']) * fraction
    return {'on': a['on'], 'intensity': level, 'color': [math.floor(c + .5) for c in color]}

def evaluate(project, t):
    return [evaluate_track(track, t) for track in project['tracks']]

def rgb_output(state):
    level = state['intensity'] / 100 if state['on'] else 0
    return [math.floor(c * level + .5) for c in state['color']]

def segment_packet(index, rgb):
    """Candidate ptReal layout from govee2mqtt. H7062 requires visual calibration."""
    import base64
    from functools import reduce
    from operator import xor
    if type(index) is not int or not 0 <= index < 6: raise ValueError('Invalid head index')
    if len(rgb) != 3 or any(type(c) is not int or not 0 <= c <= 255 for c in rgb): raise ValueError('Invalid RGB')
    packet = bytearray([0x33, 0x05, 0x15, 0x01, *rgb, 0, 0, 0, 0, 0, (1 << index), 0, 0, 0, 0, 0, 0])
    packet.append(reduce(xor, packet))
    return base64.b64encode(packet).decode('ascii')
