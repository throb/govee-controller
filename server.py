import json
import sys
import socket
import threading
import time
import uuid
import os
import re
import subprocess
import ipaddress
from pathlib import Path
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from animation import validate_project, evaluate, rgb_output, segment_packet
from govee_cloud import GoveeCloud
from device_controls import DeviceControls
from layout_controls import LayoutControls
from tablet_setup import TabletSetup
from credential_store import CredentialStore
from effect_lab import encode_timeline_frame
from show_library import ShowLibrary
from app_identity import APP_ID, installation_id

ROOT = Path(__file__).resolve().parent
INSTANCE_ID = str(uuid.uuid4())
INSTALLATION_ID = installation_id(ROOT)
DATA = ROOT / 'data'
DATA.mkdir(exist_ok=True)
SHOWS = ShowLibrary(DATA / 'shows')
PORT = 8765
# Installation details stay in ignored local storage, never in source control.
CONFIG_FILE = DATA / 'network.json'
CONFIG = json.loads(CONFIG_FILE.read_text(encoding='utf-8')) if CONFIG_FILE.exists() else {}
LAN_IP = os.environ.get('LIGHT_BRIDGE_LAN_IP', CONFIG.get('lan_ip', '0.0.0.0'))
FLOOD_ID = os.environ.get('LIGHT_BRIDGE_FLOOD_ID', CONFIG.get('flood_id', ''))
TARGETS = CONFIG.get('targets', [])

MULTICAST_GROUP = '239.255.255.250'

def local_ipv4_addresses():
    """Enumerate local interfaces without probing LAN hosts or external services."""
    if LAN_IP != '0.0.0.0': return [LAN_IP]
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET, socket.SOCK_DGRAM)}
    except socket.gaierror:
        addresses = set()
    return sorted(ip for ip in addresses if not ip.startswith('127.') and ip != '0.0.0.0') or ['0.0.0.0']

def known_neighbor_addresses(interfaces):
    """Ask only OS-learned neighbors; never generate or sweep subnet addresses."""
    try:
        result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=3,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    except (OSError, subprocess.TimeoutExpired):
        return []
    found = set()
    interface = None
    for line in result.stdout.splitlines():
        header = re.search(r'Interface:\s*([0-9.]+)', line)
        if header:
            interface = header.group(1)
            continue
        if interface is not None and interface not in interfaces: continue
        # A resolved MAC is required: incomplete/unreachable ARP entries are ignored.
        if not re.search(r'(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}', line): continue
        for token in re.findall(r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b', line):
            try: address = ipaddress.ip_address(token)
            except ValueError: continue
            if address.is_private and not address.is_multicast and not address.is_loopback and not address.is_link_local and not address.is_unspecified and token not in interfaces and 'ff-ff-ff-ff-ff-ff' not in line.lower() and 'ff:ff:ff:ff:ff:ff' not in line.lower():
                found.add(token)
    return sorted(found, key=ipaddress.ip_address)[:256]

class Network:
    def __init__(self):
        self.devices = {}
        self.condition = threading.Condition()
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # A second listener must fail instead of stealing another server's replies.
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        self.scan_lock = threading.Lock()
        self.interfaces = local_ipv4_addresses()
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        self.socket.bind((LAN_IP, 4002))
        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 1)
        self.discovery_errors = []
        for interface in self.interfaces:
            try:
                membership = socket.inet_aton(MULTICAST_GROUP) + socket.inet_aton(interface)
                self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, membership)
            except OSError as exc:
                self.discovery_errors.append(str(exc))
        self.socket.settimeout(.5)
        threading.Thread(target=self.receive, daemon=True).start()

    def send(self, ip, cmd, data, port=4003):
        self.socket.sendto(json.dumps({'msg': {'cmd': cmd, 'data': data}}).encode(), (ip, port))

    def receive(self):
        while True:
            try:
                raw, address = self.socket.recvfrom(16384)
                msg = json.loads(raw).get('msg', {})
                data = msg.get('data', {})
                if not isinstance(data, dict): continue
                ip = address[0]
                with self.condition:
                    if msg.get('cmd') == 'scan' and data.get('device') and data.get('sku'):
                        old = self.devices.get(ip, {})
                        self.devices[ip] = {'ip': ip, 'id': data['device'], 'model': data['sku'], 'seen': time.time(), 'state': old.get('state'), 'stateAt': old.get('stateAt', 0)}
                        self.send(ip, 'devStatus', {})
                    elif msg.get('cmd') in ('devStatus', 'status') and ip in self.devices:
                        if 'brightness' in data and 'onOff' in data:
                            self.devices[ip]['state'] = data
                            self.devices[ip]['stateAt'] = time.time()
                    self.condition.notify_all()
            except (socket.timeout, ConnectionResetError, ValueError, TypeError): pass

    def discover(self):
        # Serialize scans so each caller gets fresh replies from its own window.
        with self.scan_lock:
            started = time.time()
            packet = {'account_topic': 'reserve'}
            for attempt in range(3):
                for ip in TARGETS: self.send(ip, 'scan', packet, 4001)
                for interface in self.interfaces:
                    try:
                        self.socket.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
                        self.send(MULTICAST_GROUP, 'scan', packet, 4001)
                    except OSError:
                        # An unavailable VPN/interface must not cancel other adapters.
                        continue
                time.sleep(.6)
            with self.condition:
                has_flood = any(d.get('seen', 0) >= started and d.get('model') == 'H7062' for d in self.devices.values())
            if not has_flood:
                neighbors = known_neighbor_addresses(self.interfaces)
                for attempt in range(2):
                    for ip in neighbors:
                        try: self.send(ip, 'scan', packet, 4001)
                        except OSError: pass
                    if neighbors: time.sleep(.6)
            with self.condition:
                self.devices = {ip: device for ip, device in self.devices.items() if device.get('seen', 0) >= started}
                return json.loads(json.dumps(list(self.devices.values())))

    def flood(self):
        with self.condition:
            matches = [d for d in self.devices.values() if (not FLOOD_ID or d['id'] == FLOOD_ID) and d['model'] == 'H7062']
            if len(matches) > 1: raise ValueError('Multiple H7062 controllers found. Select a flood controller in Devices.')
            if matches: return dict(matches[0])
        self.discover()
        with self.condition:
            matches = [d for d in self.devices.values() if (not FLOOD_ID or d['id'] == FLOOD_ID) and d['model'] == 'H7062']
            if len(matches) > 1: raise ValueError('Multiple H7062 controllers found. Select a flood controller in Devices.')
            if not matches: raise ValueError('Flood controller did not respond. Check its power and LAN control setting.')
            return dict(matches[0])

    def inventory(self):
        with self.condition:
            devices = json.loads(json.dumps(list(self.devices.values())))
        supported = [d for d in devices if d['model'] == 'H7062']
        selected = next((d['id'] for d in supported if d['id'] == FLOOD_ID), None)
        if not FLOOD_ID and len(supported) == 1: selected = supported[0]['id']
        return {'devices': devices, 'selectedId': selected}

    def resolve_controllers(self, identifiers):
        def lookup():
            with self.condition:
                return {d['id']:dict(d) for d in self.devices.values() if d['model'] == 'H7062'}
        devices = lookup()
        if any(identifier not in devices for identifier in identifiers):
            self.discover()
            devices = lookup()
        missing = [identifier for identifier in identifiers if identifier not in devices]
        if missing: raise ValueError('Project controller unavailable: ' + ', '.join(missing) + '. Find lights before playback.')
        return [devices[identifier] for identifier in identifiers]

    def fresh_state(self, ip, timeout=2):
        before = time.time()
        self.send(ip, 'devStatus', {})
        with self.condition:
            if not self.condition.wait_for(lambda: self.devices.get(ip, {}).get('stateAt', 0) >= before, timeout=timeout):
                raise ValueError('No fresh device state. Playback was not started.')
            return json.loads(json.dumps(self.devices[ip]['state']))

    def restore(self, ip, state):
        expected = {'onOff': state['onOff'], 'brightness': max(1, min(100, state['brightness']))}
        if 'color' in state:
            expected.update(color=state['color'], colorTemInKelvin=state.get('colorTemInKelvin', 0))
        last_actual = None
        for attempt in range(3):
            self.send(ip, 'brightness', {'value': expected['brightness']})
            time.sleep(.075)
            if 'color' in expected:
                self.send(ip, 'colorwc', {'color': expected['color'], 'colorTemInKelvin': expected['colorTemInKelvin']})
                time.sleep(.075)
            self.send(ip, 'turn', {'value': expected['onOff']})
            time.sleep(.075)
            try:
                actual = self.fresh_state(ip, timeout=.6)
                last_actual = actual
                if all(actual.get(key) == value for key, value in expected.items()): return actual
            except ValueError: pass
        detail = 'no state reply' if last_actual is None else 'last reported state: ' + json.dumps(last_actual)
        raise ValueError('Controller restoration could not be confirmed by device readback; ' + detail)

class Player:
    def __init__(self, network):
        self.identifying = False
        self.net = network
        self.operation = threading.RLock()
        self.lock = threading.RLock()
        self.thread = None
        self.cancel = threading.Event()
        self.snapshot = None
        self.ip = None
        self.state = {'playing': False, 'time': 0, 'mode': 'preview', 'error': None, 'frames': 0, 'restored': None}
        self.calibration_id = None
        self.calibration_done = False
        self.calibration_file = DATA / 'calibration.json'
        try:
            pending = json.loads(self.calibration_file.read_text())
            if time.time() - pending['testAt'] < 3600:
                self.calibration_id = pending['testId']
                self.calibration_done = pending['done'] is True and pending.get('protocol') == 'cloud-segments'
        except (OSError, ValueError, KeyError, TypeError): pass
        self.profile_file = DATA / 'profile.json'
        self.applied_file = DATA / 'last-applied.json'
        try:
            self.applied = json.loads(self.applied_file.read_text(encoding='utf-8'))
            if not isinstance(self.applied, list) or len(self.applied) != 6: self.applied = [None] * 6
        except (OSError, ValueError): self.applied = [None] * 6
        self.applied_devices_file = DATA / 'applied-devices.json'
        try:
            self.applied_devices = json.loads(self.applied_devices_file.read_text(encoding='utf-8'))
            if not isinstance(self.applied_devices, dict): self.applied_devices = {}
        except (OSError, ValueError): self.applied_devices = {}
        try: self.confirmed = (lambda p: p.get('individualConfirmed') is True and p.get('protocol') == 'cloud-segments')(json.loads(self.profile_file.read_text()))
        except (OSError, ValueError): self.confirmed = False

    def status(self):
        with self.lock: return dict(self.state, individualConfirmed=self.confirmed, calibrationId=self.calibration_id, calibrationDone=self.calibration_done)

    def select_device(self, body):
        global FLOOD_ID, CONFIG
        identifier = body.get('id')
        if not isinstance(identifier, str) or not identifier: raise ValueError('Choose a discovered flood controller')
        with self.operation:
            if self.state.get('playing') or (self.thread and self.thread.is_alive()):
                raise ValueError('Stop playback or calibration before changing controllers')
            with self.net.condition:
                device = next((dict(d) for d in self.net.devices.values() if d['id'] == identifier), None)
            if device is None: raise ValueError('Controller is not discovered. Find lights again.')
            if device['model'] != 'H7062': raise ValueError('This model is discovered but not supported by the six-head editor yet')
            if identifier != FLOOD_ID:
                config = dict(CONFIG, flood_id=identifier)
                # Clear persisted head colors and test results before changing the target.
                # If a write fails, no new target can inherit another controller's state.
                for path, value in [(self.applied_file, [None] * 6), (self.profile_file, {}), (self.calibration_file, {})]:
                    temporary = path.with_suffix('.tmp')
                    temporary.write_text(json.dumps(value), encoding='utf-8')
                    temporary.replace(path)
                temporary = CONFIG_FILE.with_suffix('.tmp')
                temporary.write_text(json.dumps(config), encoding='utf-8')
                temporary.replace(CONFIG_FILE)
                CONFIG, FLOOD_ID = config, identifier
                with self.lock:
                    self.applied = [None] * 6
                    self.confirmed = False
                    self.calibration_id = None
                    self.calibration_done = False
                    self.snapshot = self.ip = None
                    self.state = {'playing': False, 'time': 0, 'mode': 'effect-frames', 'error': None, 'frames': 0, 'restored': None}
            return dict(self.net.inventory(), selectedDevice={key:device[key] for key in ('id', 'model', 'ip')})

    def stop(self):
        with self.operation:
            self.cancel.set()
            if self.thread and self.thread.is_alive(): self.thread.join(timeout=12)
            if self.thread and self.thread.is_alive(): raise ValueError('Playback is still stopping')
            self.thread = None
            with self.lock: self.state['playing'] = False
            return self.status()

    def set_loop(self, body):
        enabled = body.get("loop")
        if type(enabled) is not bool: raise ValueError("Invalid loop setting")
        with self.lock:
            self.state["loop"] = enabled
            if not enabled and self.state.get("playing"):
                self.state["stopAt"] = (self.state.get("cycle", 0) + 1) * self.state["duration"]
        return self.status()

    def start(self, body):
        project = validate_project(body.get('project'))
        mode = body.get('mode')
        if mode not in ('group', 'individual', 'calibration', 'cloud-calibration', 'individual-cloud', 'effect-frames'): raise ValueError('Invalid live output mode')
        if project.get('controllers') and mode != 'effect-frames': raise ValueError('Bound controller projects require local animation output')
        if mode in ('individual', 'individual-cloud') and not self.confirmed: raise ValueError('Individual output requires a successful visual head test first')
        position = body.get('position', 0)
        if isinstance(position, bool) or not isinstance(position, (int, float)) or not 0 <= position < project['duration']: raise ValueError('Invalid playback position')
        if type(body.get('loop', False)) is not bool: raise ValueError('Invalid loop setting')
        with self.operation:
            if self.identifying: raise ValueError('Exit identify mode first.')
            self.stop()
            if project.get('controllers'):
                devices = self.net.resolve_controllers([c['id'] for c in project['controllers']])
                # Read every controller before issuing any lighting change.
                targets = [(device, self.net.fresh_state(device['ip'])) for device in devices]
                self.cancel = threading.Event()
                start_wall = time.time() + .35
                with self.lock:
                    self.state = {'playing':True, 'time':position, 'mode':mode, 'error':None, 'frames':0, 'startWall':start_wall, 'duration':project['duration'], 'restored':None, 'loop':body.get('loop',False), 'cycle':0, 'stopAt':project['duration'], 'controllerIds':[d['id'] for d in devices]}
                self.thread = threading.Thread(target=self.run_controllers, args=(project, targets, position, start_wall), daemon=True)
                self.thread.start()
                return self.status()
            device = self.net.flood()
            snapshot = self.net.fresh_state(device['ip'])
            self.snapshot = snapshot
            self.ip = device['ip']
            self.cancel = threading.Event()
            start_wall = time.time() + .35
            with self.lock:
                self.state = {'playing': True, 'time': position, 'mode': mode, 'error': None, 'frames': 0, 'startWall': start_wall, 'duration': project['duration'], 'restored': None, 'loop': body.get('loop', False), 'cycle': 0, 'stopAt': project['duration'], 'controllerIds':[device['id']]}
            self.thread = threading.Thread(target=self.run, args=(project, mode, position, body.get('loop', False), start_wall), daemon=True)
            self.thread.start()
            return self.status()

    def run_controllers(self, project, targets, position, start_wall):
        start_mono = time.monotonic() + max(0, start_wall - time.time())
        previous = [None] * len(targets)
        try:
            for device, _ in targets:
                self.net.send(device['ip'], 'turn', {'value':1})
                self.net.send(device['ip'], 'brightness', {'value':100})
            if self.cancel.wait(max(0, start_mono - time.monotonic())): return
            next_tick = start_mono
            while not self.cancel.is_set():
                absolute = position + max(0, time.monotonic() - start_mono)
                with self.lock:
                    if not self.state.get('loop') and absolute >= self.state['stopAt']: break
                t = absolute % project['duration']
                outputs = [rgb_output(state) for state in evaluate(project, t)]
                for index, (device, _) in enumerate(targets):
                    colors = outputs[index*6:(index+1)*6]
                    if colors != previous[index]:
                        self.net.send(device['ip'], 'ptReal', {'command':encode_timeline_frame(colors)})
                        previous[index] = colors
                with self.lock:
                    self.state.update(time=t, cycle=int(absolute // project['duration']), frames=self.state['frames']+1)
                next_tick += .1
                now = time.monotonic()
                if now > next_tick: next_tick += (int((now-next_tick)/.1)+1)*.1
                if self.cancel.wait(max(0, next_tick-time.monotonic())): break
        except Exception as error:
            with self.lock: self.state['error'] = str(error)
        finally:
            failures = []
            for device, snapshot in targets:
                try: self.net.restore(device['ip'], snapshot)
                except Exception as error: failures.append(device['id'] + ': ' + str(error))
            with self.lock:
                self.state.update(playing=False, restored=not failures)
                if failures: self.state['error'] = 'Restore failed: ' + '; '.join(failures)

    def run(self, project, mode, position, loop, start_wall):
        last = [None] * 6
        start_mono = time.monotonic() + max(0, start_wall - time.time())
        calibration_complete = False
        try:
            if mode in ('individual', 'calibration', 'cloud-calibration', 'individual-cloud', 'effect-frames'):
                self.net.send(self.ip, 'turn', {'value': 1})
                self.net.send(self.ip, 'brightness', {'value': 30 if mode in ('calibration', 'cloud-calibration') else 100})
            if self.cancel.wait(max(0, start_mono - time.monotonic())): return
            if mode == 'cloud-calibration':
                for i, state in enumerate(evaluate(project, 0)):
                    if self.cancel.is_set(): return
                    CLOUD.segment_color(FLOOD_ID or self.net.flood()['id'], i, state['color'])
                    with self.lock: self.state['frames'] += 1
                calibration_complete = not self.cancel.wait(8)
                return
            next_tick = start_mono
            while not self.cancel.is_set():
                absolute = position + max(0, time.monotonic() - start_mono)
                with self.lock:
                    loop = self.state.get('loop', loop)
                    stop_at = self.state.get('stopAt', project['duration'])
                if absolute >= stop_at and not loop:
                    calibration_complete = mode == 'calibration'
                    break
                t = absolute % project['duration']
                states = evaluate(project, t)
                if mode == 'group':
                    state = states[0]
                    output = (state['on'] and state['intensity'] > 0, round(state['intensity']), tuple(state['color']))
                    if output != last[0]:
                        if output[0]:
                            self.net.send(self.ip, 'brightness', {'value': max(1, output[1])})
                            self.net.send(self.ip, 'colorwc', {'color': dict(zip(('r','g','b'), output[2])), 'colorTemInKelvin': 0})
                        self.net.send(self.ip, 'turn', {'value': int(output[0])})
                        last[0] = output
                elif mode == 'effect-frames':
                    outputs = [rgb_output(state) for state in states]
                    if outputs != last:
                        self.net.send(self.ip, 'ptReal', {'command': encode_timeline_frame(outputs)})
                        last = outputs
                else:
                    for i, state in enumerate(states):
                        output = rgb_output(state)
                        if output != last[i]:
                            if self.cancel.is_set(): break
                            if mode == 'individual-cloud': CLOUD.segment_color(FLOOD_ID or self.net.flood()['id'], i, output)
                            else: self.net.send(self.ip, 'ptReal', {'command': [segment_packet(i, output)]})
                            last[i] = output
                with self.lock:
                    self.state['time'] = t
                    self.state['cycle'] = int(absolute // project['duration'])
                    self.state['frames'] += 1
                interval = .1
                next_tick += interval
                now = time.monotonic()
                # Skip missed deadlines rather than burst stale frames at the controller.
                if now > next_tick:
                    next_tick += (int((now - next_tick) / interval) + 1) * interval
                if self.cancel.wait(max(0, next_tick - time.monotonic())): break
        except Exception as error:
            with self.lock: self.state['error'] = str(error)
        finally:
            try:
                cloud_restore_error = None
                if mode in ('cloud-calibration', 'individual-cloud'):
                    rgb = [self.snapshot['color'][c] for c in ('r','g','b')]
                    try:
                        for i in range(6): CLOUD.segment_color(FLOOD_ID or self.net.flood()['id'], i, rgb)
                    except ValueError as error: cloud_restore_error = error
                restored_state = self.net.restore(self.ip, self.snapshot)
                if cloud_restore_error: raise cloud_restore_error
                with self.lock:
                    self.state['restored'] = True
                    self.state['restoreState'] = restored_state
            except (OSError, ValueError, KeyError, TypeError) as error:
                with self.lock:
                    self.state['restored'] = False
                    self.state['error'] = 'Restore failed: ' + str(error)
            with self.lock:
                self.state['playing'] = False
                if calibration_complete and self.state.get('restored') is True:
                    self.calibration_done = True
                    try: self.calibration_file.write_text(json.dumps({'testId':self.calibration_id,'done':True,'testAt':time.time(),'protocol':'cloud-segments'}))
                    except OSError as error: self.state['error'] = 'Could not save calibration result: ' + str(error)

    def calibrate(self):
        colors = [[255,0,0], [0,255,0], [0,0,255], [255,128,0], [255,0,255], [0,255,255]]
        project = {'version': 1, 'duration': 8, 'tracks': [{'name': f'Flood {i+1}', 'keys': [{'t': 0, 'on': True, 'intensity': 100, 'color': c, 'ease': 'jump'}]} for i,c in enumerate(colors)]}
        with self.operation:
            if self.identifying: raise ValueError('Exit identify mode first.')
            self.stop()
            self.calibration_id = str(uuid.uuid4())
            self.calibration_done = False
            self.calibration_file.write_text(json.dumps({'testId':self.calibration_id,'done':False,'testAt':time.time()}))
            return self.start({'project': project, 'mode': 'cloud-calibration'})

    def confirm(self, body):
        with self.operation:
            if body.get('testId') != self.calibration_id or not self.calibration_done or body.get('observed') is not True:
                raise ValueError('Run the test and visually confirm six independent colors first')
            self.confirmed = True
            self.profile_file.write_text(json.dumps({'individualConfirmed': True, 'deviceId': FLOOD_ID, 'confirmedAt': time.time(), 'protocol': 'cloud-segments'}))
            return self.status()

    def manual(self, body):
        target = body.get('target')
        color = body.get('color')
        level = body.get('intensity')
        on = body.get('on')
        if target != 'all' and (type(target) is not int or not 0 <= target < 6): raise ValueError('Choose a flood or the whole set')
        if not isinstance(color, list) or len(color) != 3 or any(type(c) is not int or not 0 <= c <= 255 for c in color): raise ValueError('Invalid color')
        if type(level) is not int or not 0 <= level <= 100 or type(on) is not bool: raise ValueError('Invalid power or intensity')
        with self.operation:
            if self.identifying: raise ValueError('Exit identify mode first.')
            self.stop()
            device = self.net.resolve_controllers([body['deviceId']])[0] if body.get('deviceId') else self.net.flood()
            if target == 'all':
                state = {'onOff': int(on and level > 0), 'brightness': max(1, level), 'color':dict(zip(('r','g','b'),color)), 'colorTemInKelvin':0}
                actual = self.net.restore(device['ip'], state)
                self.remember_applied(target, color, level, on, device['id'])
                return {'applied':True, 'confirmed':True, 'state':actual}
            if not self.confirmed: raise ValueError('Run and confirm the separate-head test first')
            # Individual intensity is encoded in RGB; do not alter other heads' master brightness.
            rgb = [round(c * level / 100) if on else 0 for c in color]
            CLOUD.segment_color(device['id'], target, rgb)
            self.remember_applied(target, color, level, on, device['id'])
            return {'applied':True, 'confirmed':False}

    def remember_applied(self, target, color, level, on, device_id=None):
        value = {'color':list(color), 'intensity':level, 'on':on, 'appliedAt':time.time()}
        with self.lock:
            if device_id:
                values = self.applied_devices.setdefault(device_id, [None] * 6)
                for index in (range(6) if target == 'all' else [target]): values[index] = dict(value)
                temporary = self.applied_devices_file.with_suffix('.tmp')
                temporary.write_text(json.dumps(self.applied_devices), encoding='utf-8')
                temporary.replace(self.applied_devices_file)
                if device_id != FLOOD_ID: return
            for index in (range(6) if target == 'all' else [target]): self.applied[index] = dict(value)
            temporary = self.applied_file.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.applied), encoding='utf-8')
            temporary.replace(self.applied_file)

    def invalidate_applied(self, device_id):
        with self.lock:
            self.applied_devices.pop(device_id, None)
            temporary = self.applied_devices_file.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.applied_devices), encoding='utf-8')
            temporary.replace(self.applied_devices_file)
            if device_id == FLOOD_ID:
                self.applied = [None] * 6
                temporary = self.applied_file.with_suffix('.tmp')
                temporary.write_text(json.dumps(self.applied), encoding='utf-8')
                temporary.replace(self.applied_file)

NET = None
PLAYER = None
CLOUD = GoveeCloud(CredentialStore(DATA / 'govee-key.dpapi'))

class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args): pass
    def allowed(self):
        return self.headers.get('Sec-Fetch-Site') != 'cross-site' and self.headers.get('Host') in (f'127.0.0.1:{PORT}', f'localhost:{PORT}') and self.headers.get('Origin') in (None, f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}')
    def respond(self, status, value):
        self.bytes_response(status, json.dumps(value).encode(), 'application/json')
    def bytes_response(self, status, data, mime):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.end_headers()
        try: self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError): pass
    def do_GET(self):
        if not self.allowed(): self.respond(403, {'error':'Origin rejected'}); return
        path = urlparse(self.path).path
        if path == '/api/mcp/setup':
            self.respond(200, {'config':{'mcpServers':{'light-bridge':{'command':sys.executable, 'args':[str(ROOT / 'mcp_server.py')]}}}}); return
        if path == '/api/instance': self.respond(200, {'app':APP_ID, 'instanceId':INSTANCE_ID, 'installationId':INSTALLATION_ID}); return
        if path == '/api/shows': self.respond(200, {'shows': SHOWS.list()}); return
        if path.startswith('/api/shows/'):
            try: self.respond(200, SHOWS.load(path.removeprefix('/api/shows/')))
            except ValueError as error: self.respond(400, {'error': str(error)})
            except FileNotFoundError: self.respond(404, {'error': 'Show not found'})
            except OSError as error: self.respond(503, {'error': str(error)})
            return
        if path == '/api/cloud/status': self.respond(200, CLOUD.status()); return
        if path == '/api/status': self.respond(200, PLAYER.status()); return
        if path == '/api/devices': self.respond(200, DeviceControls(NET, CLOUD, PLAYER).inventory()); return
        if path == '/api/layout': self.respond(200, LAYOUT.snapshot()); return
        if path == '/api/light-state':
            identifier = parse_qs(urlparse(self.path).query).get('deviceId', [None])[0]
            applied = PLAYER.applied_devices.get(identifier, [None]*6) if identifier else PLAYER.applied
            try:
                device = NET.resolve_controllers([identifier])[0] if identifier else NET.flood()
                state = NET.fresh_state(device['ip'])
                self.respond(200, {'controller':state, 'device':{key:device[key] for key in ('id', 'model', 'ip')}, 'selectedId':device['id'], 'lastApplied':applied, 'readAt':time.time(), 'individualReadback':False})
            except (ValueError, OSError): self.respond(200, {'controller':None, 'device':None, 'selectedId':identifier or NET.inventory()['selectedId'], 'lastApplied':applied, 'readAt':None, 'individualReadback':False})
            return
        if path == '/api/project':
            try: self.respond(200, json.loads((DATA / 'project.json').read_text()))
            except FileNotFoundError: self.respond(200, None)
            return
        if path.startswith('/audio/'):
            name = path.removeprefix('/audio/')
            try:
                uuid.UUID(name)
                self.bytes_response(200, (DATA / (name + '.audio')).read_bytes(), 'application/octet-stream')
            except (ValueError, OSError): self.respond(404, {'error':'Audio not found'})
            return
        files = {'/mcp-guide': ('MCP_GUIDE.md','text/plain; charset=utf-8'), '/': ('index.html','text/html; charset=utf-8'), '/app.js': ('app.js','text/javascript; charset=utf-8'), '/style.css': ('style.css','text/css; charset=utf-8'), '/timeline.js': ('timeline.js','text/javascript; charset=utf-8')}
        if path not in files: self.respond(404, {'error':'Not found'}); return
        filename, mime = files[path]
        self.bytes_response(200, (ROOT / filename).read_bytes(), mime)
    def do_POST(self):
        if not self.allowed(): self.respond(403, {'error':'Origin rejected'}); return
        if self.headers.get('X-LightBridge-Instance') != INSTANCE_ID:
            self.respond(409, {'error':'This tab belongs to an older or different server. Reload to connect to the current installation.', 'code':'instance_changed'}); return
        try:
            path = urlparse(self.path).path
            size = int(self.headers.get('Content-Length', 0))
            limit = 100 * 1024 * 1024 if path == '/api/audio' else 4 * 1024 * 1024
            if not 0 < size <= limit: raise ValueError('Request too large or empty')
            raw = self.rfile.read(size)
            if path == '/api/audio':
                name = str(uuid.uuid4())
                (DATA / (name + '.audio')).write_bytes(raw)
                self.respond(200, {'ref':name}); return
            body = json.loads(raw)
            if path == '/api/cloud/connect': result = CLOUD.connect(body.get('apiKey'))
            elif path == '/api/cloud/reconnect': CLOUD.reconnect(); result = CLOUD.status()
            elif path == '/api/cloud/disconnect': result = CLOUD.disconnect()
            elif path == '/api/discover': result = NET.discover()
            elif path == '/api/devices/refresh':
                NET.discover()
                cloud_error = None
                try: CLOUD.refresh()
                except ValueError as error: cloud_error = str(error)
                result = DeviceControls(NET, CLOUD, PLAYER).inventory()
                result['cloudError'] = cloud_error
            elif path == '/api/devices/state': result = DeviceControls(NET, CLOUD, PLAYER).state(body.get('id'))
            elif path == '/api/devices/scenes': result = CLOUD.device_request(body.get('id'), 'diy-scenes' if body.get('diy') else 'scenes')
            elif path == '/api/devices/control': result = DeviceControls(NET, CLOUD, PLAYER).control(body)
            elif path == '/api/devices/select': result = PLAYER.select_device(body)
            elif path == '/api/layout/move': result = LAYOUT.move(body)
            elif path == '/api/layout/identify': result = LAYOUT.identify(body)
            elif path == '/api/layout/identify/start': result = LAYOUT.begin_identify()
            elif path == '/api/layout/identify/end': result = LAYOUT.end_identify()
            elif path == '/api/tablet/enable': result = TABLET.enable(local_ipv4_addresses())
            elif path == '/api/tablet/disable': result = TABLET.disable()
            elif path == '/api/play': result = PLAYER.start(body)
            elif path == '/api/manual': result = PLAYER.manual(body)
            elif path == '/api/stop': result = PLAYER.stop()
            elif path == '/api/loop': result = PLAYER.set_loop(body)
            elif path == '/api/calibrate': result = PLAYER.calibrate()
            elif path == '/api/confirm': result = PLAYER.confirm(body)
            elif path == '/api/shows/save': result = SHOWS.save(body.get('project'), body.get('id'))
            elif path == '/api/save':
                validate_project(body)
                if body.get('audioRef'): uuid.UUID(body['audioRef'])
                temp = DATA / 'project.tmp'
                with PLAYER.operation:
                    if (DATA / 'project.json').exists():
                        current = json.loads((DATA / 'project.json').read_text(encoding='utf-8'))
                        same = (current.get('layoutId') or current.get('libraryShowId') or current.get('name')) == (body.get('layoutId') or body.get('libraryShowId') or body.get('name'))
                        if same and current.get('layoutRevision',0) > body.get('layoutRevision',0):
                            raise ValueError('Layout changed on another screen. Reload before saving to avoid overwriting it.')
                        if same and current.get('layout') != body.get('layout'): body['layoutRevision'] = max(current.get('layoutRevision',0),body.get('layoutRevision',0))+1
                    temp.write_text(json.dumps(body))
                    temp.replace(DATA / 'project.json')
                result = {'saved':True, 'layoutRevision':body.get('layoutRevision',0)}
            else: self.respond(404, {'error':'Not found'}); return
            self.respond(200, result)
        except (ValueError, KeyError, TypeError, AttributeError) as error: self.respond(400, {'error':str(error)})
        except OSError as error: self.respond(503, {'error':str(error)})

if __name__ == '__main__':
    threading.Thread(target=CLOUD.reconnect, daemon=True).start()
    NET = Network()
    PLAYER = Player(NET)
    LAYOUT = LayoutControls(DATA / 'project.json', NET, PLAYER, DeviceControls(NET,CLOUD,PLAYER))
    TABLET = TabletSetup(ROOT, LAYOUT.snapshot, LAYOUT.move, LAYOUT.identify, PLAYER.stop, LAYOUT.begin_identify, LAYOUT.end_identify)
    print(f'Light Bridge Studio: http://127.0.0.1:{PORT}', flush=True)
    try: ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
    finally:
        LAYOUT.end_identify()
        PLAYER.stop()
