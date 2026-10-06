"""Shared desktop/tablet placement with optimistic concurrency and identification."""
import json
import math
import time
from effect_lab import encode_timeline_frame

class LayoutControls:
    def __init__(self, path, network, player, controls):
        self.path,self.network,self.player,self.controls=path,network,player,controls
        self.identify_states = {}
        self.identify_key = None
    def load(self):
        return json.loads(self.path.read_text(encoding='utf-8'))
    def snapshot(self):
        with self.player.operation:
            p=self.load();lights=[]
            for i,f in enumerate(p.get('layout',{}).get('fixtures',[])):
                controllers=p.get('controllers')
                identifier=controllers[i//6]['id'] if controllers else self.network.inventory()['selectedId']
                lights.append(dict(f,key='track:'+str(i),name=p['tracks'][i]['name'],deviceId=identifier,head=i%6,model='H7062'))
            for f in p.get('layout',{}).get('lights',[]):lights.append(dict(f,key='device:'+f['deviceId']))
            return {'lights':lights,'projectId':p.get('layoutId') or p.get('libraryShowId') or p.get('name'), 'revision':p.get('layoutRevision',0),'playing':self.player.status().get('playing',False),'identifying':bool(self.identify_states),'identifiedKey':self.identify_key}
    def move(self,body):
        with self.player.operation:
            p=self.load()
            if body.get('projectId') != (p.get('layoutId') or p.get('libraryShowId') or p.get('name')):raise ValueError('The active show changed. Refresh the layout.')
            if body.get('revision')!=p.get('layoutRevision',0):raise ValueError('Layout changed on another screen. Refresh and try again.')
            key=body.get('key','')
            if key.startswith('track:'):
                index=int(key[6:])
                if not 0<=index<len(p['tracks']):raise ValueError('Unknown light')
                f=p['layout']['fixtures'][index]
            else:
                f=next((f for f in p.get('layout',{}).get('lights',[]) if 'device:'+f['deviceId']==key),None)
                if f is None:raise ValueError('Unknown light')
            for name,low,high in [('x',5,95),('y',8,92)]:
                v=body.get(name)
                if type(v) not in (float,int) or not math.isfinite(v) or not low<=v<=high:raise ValueError('Invalid position')
                f[name]=v
            p['layoutRevision']=p.get('layoutRevision',0)+1
            temp=self.path.with_suffix('.tmp');temp.write_text(json.dumps(p),encoding='utf-8');temp.replace(self.path)
            return self.snapshot()
    def begin_identify(self):
        with self.player.operation:
            if self.identify_states: return self.snapshot()
            self.player.stop()
            lights = self.snapshot()['lights']
            devices = {}
            for f in lights:
                d = self.controls.device(f['deviceId'])
                if d.get('deviceType') not in (None, 'devices.types.light'): raise ValueError('Only lights can be identified')
                if not d.get('ip'): raise ValueError('Cannot darken every added light: '+str(d.get('name',d['id']))+' has no LAN connection')
                devices[d['id']] = d
            if not devices: raise ValueError('Add lights before starting identification')
            # Preflight all controllers before changing any output.
            states = {identifier:(d,self.network.fresh_state(d['ip'])) for identifier,d in devices.items()}
            self.identify_states = states
            self.player.identifying = True
            try: self.blackout()
            except Exception:
                self.end_identify()
                raise
            return self.snapshot()

    def blackout(self):
        for d,_ in self.identify_states.values():
            self.network.send(d['ip'],'turn',{'value':0})
        for d,_ in self.identify_states.values():
            for attempt in range(3):
                time.sleep(.1)
                state=self.network.fresh_state(d['ip'])
                if state.get('onOff')==0:break
                self.network.send(d['ip'],'turn',{'value':0})
            else:raise ValueError('Could not confirm lights off for '+d['id'])
        self.identify_key=None

    def end_identify(self):
        with self.player.operation:
            failures=[]
            for identifier,(d,state) in list(self.identify_states.items()):
                try:
                    self.network.restore(d['ip'],state)
                    self.player.invalidate_applied(identifier)
                    del self.identify_states[identifier]
                except Exception as error: failures.append(identifier+': '+str(error))
            self.identify_key=None
            self.player.identifying = bool(self.identify_states)
            if failures: raise ValueError('Could not restore all lights; retry Exit identify mode. '+ '; '.join(failures))
            return {'identifying':False,'restored':True,'perHeadStartingColorsRestored':False}

    def identify(self,body):
        with self.player.operation:
            f=next((f for f in self.snapshot()['lights'] if f['key']==body.get('key')),None)
            if not f:raise ValueError('Unknown light')
            if not self.identify_states:self.begin_identify()
            if f['deviceId'] not in self.identify_states:raise ValueError('Layout changed. Exit and restart identify mode.')
            d,_=self.identify_states[f['deviceId']]
            try:
                self.blackout()
                self.network.send(d['ip'],'brightness',{'value':35})
                if f.get('head') is not None:
                    colors=[[0,0,0] for _ in range(6)];colors[f['head']]=[255,255,255]
                    self.network.send(d['ip'],'ptReal',{'command':encode_timeline_frame(colors)})
                else:self.network.send(d['ip'],'colorwc',{'color':{'r':255,'g':255,'b':255},'colorTemInKelvin':0})
                self.network.send(d['ip'],'turn',{'value':1})
                self.identify_key=f['key']
            except Exception:
                self.blackout()
                raise
            return {'identifying':True,'identifiedKey':self.identify_key,'restored':False}
