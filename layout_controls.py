"""Shared desktop/tablet placement with optimistic concurrency and identification."""
import json
import math
import time
from effect_lab import encode_timeline_frame

class LayoutControls:
    def __init__(self, path, network, player, controls):
        self.path,self.network,self.player,self.controls=path,network,player,controls
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
            return {'lights':lights,'projectId':p.get('layoutId') or p.get('libraryShowId') or p.get('name'), 'revision':p.get('layoutRevision',0),'playing':self.player.status().get('playing',False)}
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
    def identify(self,body):
        with self.player.operation:
            if self.player.status().get('playing'):raise ValueError('Pause the show before identifying a light.')
            f=next((f for f in self.snapshot()['lights'] if f['key']==body.get('key')),None)
            if not f:raise ValueError('Unknown light')
            d=self.controls.device(f['deviceId'])
            if d.get('deviceType') not in (None,'devices.types.light'):raise ValueError('Identification is available only for lights')
            if not d.get('ip'):raise ValueError('Identification currently needs a LAN-connected light; use its device controls for cloud-only lights.')
            state=self.network.fresh_state(d['ip'])
            try:
                self.network.send(d['ip'],'turn',{'value':1})
                self.network.send(d['ip'],'brightness',{'value':35})
                if f.get('head') is not None:
                    colors=[[0,0,0] for _ in range(6)];colors[f['head']]=[255,255,255]
                    self.network.send(d['ip'],'ptReal',{'command':encode_timeline_frame(colors)})
                else:self.network.send(d['ip'],'colorwc',{'color':{'r':255,'g':255,'b':255},'colorTemInKelvin':0})
                time.sleep(2)
            finally:
                self.network.restore(d['ip'],state)
                self.player.invalidate_applied(d['id'])
            return {'identified':True,'restored':True,'perHeadStartingColorsRestored':False}
