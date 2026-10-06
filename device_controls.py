"""Model-independent Govee lighting capabilities and validated control routing."""
import copy
import math
import time


def validate_value(spec, value):
    kind = str(spec.get('dataType', '')).upper()
    options = spec.get('options', [])
    if kind == 'ENUM':
        if not any(type(value) is type(o.get('value')) and value == o.get('value') for o in options):
            raise ValueError('Choose a supported option')
    elif kind in ('INTEGER', 'FLOAT'):
        if type(value) not in (int, float) or not math.isfinite(value) or (kind == 'INTEGER' and type(value) is not int):
            raise ValueError('Expected a valid ' + kind.lower())
        limits = spec.get('range', {})
        if not limits.get('min', -float('inf')) <= value <= limits.get('max', float('inf')):
            raise ValueError('Value outside device range')
    elif kind == 'STRUCT':
        if not isinstance(value, dict): raise ValueError('Expected structured capability value')
        fields = {f['fieldName']: f for f in spec.get('fields', [])}
        if set(value) - set(fields): raise ValueError('Unknown capability field')
        for name, field in fields.items():
            if field.get('required') and name not in value: raise ValueError('Missing ' + name)
            if name in value: validate_value(field, value[name])
    elif kind == 'ARRAY':
        if not isinstance(value, list) or not value or len(value) > 1024: raise ValueError('Expected a nonempty array')
        for item in value:
            if options: validate_value({'dataType': 'ENUM', 'options': options}, item)
            elif spec.get('elementRange'): validate_value({'dataType':'INTEGER', 'range':spec['elementRange']}, item)
            else: raise ValueError('Device did not advertise array values')
    else:
        raise ValueError('Unsupported parameter schema: ' + kind)


def supported_schema(spec):
    kind = str(spec.get('dataType', '')).upper()
    if kind == 'STRUCT': return bool(spec.get('fields')) and all(supported_schema(f) for f in spec['fields'])
    if kind == 'ARRAY': return bool(spec.get('options') or spec.get('elementRange'))
    if kind == 'ENUM': return bool(spec.get('options'))
    return kind in ('INTEGER', 'FLOAT') and bool(spec.get('range'))


def lan_capabilities():
    return [
        {'type':'devices.capabilities.on_off','instance':'powerSwitch','parameters':{'dataType':'ENUM','options':[{'name':'On','value':1},{'name':'Off','value':0}]}},
        {'type':'devices.capabilities.range','instance':'brightness','parameters':{'dataType':'INTEGER','range':{'min':1,'max':100}}},
        {'type':'devices.capabilities.color_setting','instance':'colorRgb','parameters':{'dataType':'INTEGER','range':{'min':0,'max':16777215}}},
        {'type':'devices.capabilities.color_setting','instance':'colorTemperatureK','parameters':{'dataType':'INTEGER','range':{'min':2000,'max':9000}}},
    ]


class DeviceControls:
    def __init__(self, network, cloud, player):
        self.network, self.cloud, self.player = network, cloud, player

    def inventory(self):
        result = self.network.inventory()
        devices = {d['id']:dict(d, name=d['model'], source='LAN', cloud=False, capabilities=lan_capabilities()) for d in result['devices']}
        with self.cloud.lock:
            for raw in self.cloud.devices:
                identifier = raw.get('device')
                if not identifier: continue
                d = devices.setdefault(identifier, {'id':identifier,'model':raw.get('sku'), 'ip':None})
                d.update(name=raw.get('deviceName') or raw.get('sku'), deviceType=raw.get('type'), cloud=True,
                         source='LAN + Govee API' if d.get('ip') else 'Govee API', capabilities=copy.deepcopy(raw.get('capabilities', [])))
        for d in devices.values():
            is_light = d.get('deviceType') in (None, 'devices.types.light')
            d['animationSupported'] = d['model'] == 'H7062' and bool(d.get('ip'))
            for cap in d['capabilities']:
                cap['controllable'] = is_light and supported_schema(cap.get('parameters', {}))
                if not cap['controllable']: cap['unsupportedReason'] = 'Read-only or parameter schema unavailable' if is_light else 'Not a lighting device'
            d['controlSupported'] = any(c['controllable'] for c in d['capabilities'])
        return dict(result, devices=list(devices.values()))

    def device(self, identifier):
        device = next((d for d in self.inventory()['devices'] if d['id'] == identifier), None)
        if device is None: raise ValueError('Device not discovered. Find lights first.')
        return device

    def state(self, identifier):
        d = self.device(identifier)
        if d.get('ip'):
            try: return {'id':identifier,'source':'LAN','state':self.network.fresh_state(d['ip']), 'readAt':time.time()}
            except ValueError:
                if not d['cloud']: raise
        return {'id':identifier,'source':'Govee API','state':self.cloud.device_request(identifier, 'state'), 'readAt':time.time()}

    def scenes(self, identifier):
        self.device(identifier)
        return self.cloud.device_request(identifier, 'scenes')

    def control(self, body):
        d = self.device(body.get('id'))
        cap = next((c for c in d['capabilities'] if c.get('type') == body.get('type') and c.get('instance') == body.get('instance')), None)
        if cap is None or not cap['controllable']: raise ValueError('This device does not advertise that control')
        value = body.get('value')
        validate_value(cap['parameters'], value)
        with self.player.operation:
            status = self.player.status()
            if status.get('playing') and d['id'] in status.get('controllerIds', []):
                raise ValueError('This light is playing the show. Stop playback before direct control.')
            instance = cap['instance']
            if d.get('ip') and instance in ('powerSwitch','brightness','colorRgb','colorTemperatureK'):
                if instance == 'powerSwitch': command, data = 'turn', {'value':value}
                elif instance == 'brightness': command, data = 'brightness', {'value':value}
                elif instance == 'colorRgb': command, data = 'colorwc', {'color':{'r':value >> 16,'g':value >> 8 & 255,'b':value & 255}, 'colorTemInKelvin':0}
                else: command, data = 'colorwc', {'color':{'r':0,'g':0,'b':0}, 'colorTemInKelvin':value}
                self.network.send(d['ip'], command, data)
                self.player.invalidate_applied(d['id'])
                return {'accepted':True,'source':'LAN','readback':self.state(d['id']), 'physicalOutputVerified':False}
            result = self.cloud.device_request(d['id'], 'control', {'type':cap['type'],'instance':instance,'value':value})
            self.player.invalidate_applied(d['id'])
            return {'accepted':True,'source':'Govee API','response':result,'physicalOutputVerified':False}
