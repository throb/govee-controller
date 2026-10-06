"""Govee capability discovery with optional encrypted credential persistence."""
import json
import threading
import urllib.request
import urllib.error
import uuid
import time

DEVICES_URL = 'https://openapi.api.govee.com/router/api/v1/user/devices'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        raise urllib.error.HTTPError(request.full_url, code, 'Redirect rejected', headers, fp)

class GoveeCloud:
    def __init__(self, store=None):
        self.lock = threading.RLock()
        self.key = None
        self.devices = []
        self.store = store
        self.saved = bool(store and store.path.exists())
        self.last_control = 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def connect(self, key):
        if not isinstance(key, str): raise ValueError('Enter your Govee API key')
        key = key.strip()
        if not 8 <= len(key) <= 256 or any(ord(c) < 33 or ord(c) > 126 for c in key):
            raise ValueError('Enter a valid API key without spaces')
        request = urllib.request.Request(DEVICES_URL, headers={'Govee-API-Key': key, 'Content-Type': 'application/json'})
        with self.lock:
            try:
                with self.opener.open(request, timeout=15) as response:
                    raw = response.read(4 * 1024 * 1024 + 1)
                if len(raw) > 4 * 1024 * 1024: raise ValueError('Govee returned too much data')
                result = json.loads(raw)
            except urllib.error.HTTPError as error:
                if error.code in (401,403): raise ValueError('Govee rejected this API key. Check the key and try again.') from None
                if error.code == 429: raise ValueError('Govee request limit reached. Wait a minute before reconnecting.') from None
                raise ValueError('Govee connection failed. Try again later.') from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise ValueError('Could not reach Govee. Check your internet connection and try again.') from None
            except (json.JSONDecodeError, UnicodeDecodeError):
                raise ValueError('Govee returned an unreadable response') from None
            if not isinstance(result, dict) or result.get('code') != 200 or not isinstance(result.get('data'), list):
                raise ValueError('Govee did not accept the request. Check your API key and try again.')
            if self.store:
                self.store.save(key)
                self.saved = True
            self.devices = [d for d in result['data'] if isinstance(d, dict)]
            self.key = key
            return self.status()

    def reconnect(self):
        if self.store:
            try:
                key = self.store.load()
                if key: self.connect(key)
            except (ValueError, OSError):
                pass

    def segment_color(self, device_id, index, rgb):
        with self.lock:
            if not self.key: raise ValueError('Connect Govee in Settings for individual flood control')
            if type(index) is not int or not 0 <= index < 6 or len(rgb) != 3 or any(type(c) is not int or not 0 <= c <= 255 for c in rgb):
                raise ValueError('Invalid flood color')
            device = next((d for d in self.devices if d.get('device') == device_id and d.get('sku') == 'H7062'), None)
            if device is None: raise ValueError('Flood controller is missing from the Govee account')
            time.sleep(max(0, .6 - (time.monotonic() - self.last_control)))
            body = {'requestId': str(uuid.uuid4()), 'payload': {'sku': 'H7062', 'device': device_id, 'capability': {'type': 'devices.capabilities.segment_color_setting', 'instance': 'segmentedColorRgb', 'value': {'segment': [index], 'rgb': (rgb[0] << 16) | (rgb[1] << 8) | rgb[2]}}}}
            request = urllib.request.Request('https://openapi.api.govee.com/router/api/v1/device/control', data=json.dumps(body).encode(), headers={'Govee-API-Key':self.key,'Content-Type':'application/json'})
            try:
                self.last_control = time.monotonic()
                with self.opener.open(request, timeout=10) as response: result = json.loads(response.read(1024*1024))
            except (urllib.error.URLError, OSError, ValueError):
                raise ValueError('Govee could not apply the flood color. Check the API connection.') from None
            if not isinstance(result, dict) or result.get('code') != 200:
                raise ValueError('Govee rejected the individual flood command')
            return result

    def disconnect(self):
        with self.lock:
            self.key = None
            self.devices = []
            return self.status()

    def refresh(self):
        with self.lock:
            if self.key: return self.connect(self.key)
            return self.status()

    def device_request(self, identifier, action, capability=None):
        if action not in ('state', 'scenes', 'diy-scenes', 'control'): raise ValueError('Unknown device action')
        with self.lock:
            if not self.key: raise ValueError('Connect your Govee API key in Settings → API')
            device = next((d for d in self.devices if d.get('device') == identifier), None)
            if device is None: raise ValueError('Device is not in your Govee account')
            payload = {'sku':device['sku'], 'device':identifier}
            if capability is not None: payload['capability'] = capability
            time.sleep(max(0, .6 - (time.monotonic() - self.last_control)))
            request = urllib.request.Request('https://openapi.api.govee.com/router/api/v1/device/' + action,
                data=json.dumps({'requestId':str(uuid.uuid4()), 'payload':payload}, allow_nan=False).encode(),
                headers={'Govee-API-Key':self.key, 'Content-Type':'application/json'})
            try:
                self.last_control = time.monotonic()
                with self.opener.open(request, timeout=15) as response: raw = response.read(4*1024*1024+1)
                if len(raw)>4*1024*1024: raise ValueError('Response too large')
                result = json.loads(raw)
            except urllib.error.HTTPError as error:
                if error.code == 429: raise ValueError('Govee rate limit reached. Wait before retrying.') from None
                raise ValueError('Govee device request failed (HTTP '+str(error.code)+')') from None
            except (urllib.error.URLError, OSError, ValueError):
                raise ValueError('Govee device request failed. Check the API connection.') from None
            if not isinstance(result, dict) or result.get('code') != 200: raise ValueError('Govee rejected the device request')
            if action in ('scenes','diy-scenes'):
                for new in result.get('payload', {}).get('capabilities', []):
                    existing = next((c for c in device.get('capabilities', []) if c.get('type')==new.get('type') and c.get('instance')==new.get('instance')), None)
                    if existing:
                        options = existing.setdefault('parameters', {}).setdefault('options', [])
                        for option in new.get('parameters', {}).get('options', []):
                            if option not in options: options.append(option)
                    else: device.setdefault('capabilities', []).append(new)
            return result.get('payload', result)

    def status(self):
        with self.lock:
            floods = []
            for device in self.devices:
                if device.get('sku') != 'H7062': continue
                capabilities = [c for c in device.get('capabilities', []) if isinstance(c, dict)]
                segment = [c for c in capabilities if c.get('type') == 'devices.capabilities.segment_color_setting']
                instances = {c.get('instance') for c in segment}
                floods.append({'id': device.get('device'), 'name': device.get('deviceName', 'H7062 flood lights'), 'segmentColor': 'segmentedColorRgb' in instances, 'segmentBrightness': 'segmentedBrightness' in instances, 'segmentCapabilities': segment})
            return {'connected': self.key is not None, 'keySaved': self.saved, 'deviceCount': len(self.devices), 'floods': floods}
