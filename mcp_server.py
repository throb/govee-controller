"""Light Bridge MCP stdio server. Only JSON-RPC goes to stdout."""
import json
import sys
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from animation import validate_project, evaluate, rgb_output
from app_identity import matches_installation

BASE = 'http://127.0.0.1:8765'
ROOT = Path(__file__).resolve().parent

def api(path, body=None):
    headers = {'Content-Type':'application/json'}
    if body is not None:
        identity = api('/api/instance')
        if not matches_installation(identity, ROOT):
            raise ValueError('A different Light Bridge installation is running. Start the installation configured for this MCP server.')
        headers['X-LightBridge-Instance'] = identity['instanceId']
    req = Request(BASE + path, data=None if body is None else json.dumps(body, allow_nan=False).encode(), headers=headers)
    try:
        with urlopen(req, timeout=20) as response: return json.load(response)
    except HTTPError as error:
        try: detail = json.load(error).get('error', str(error))
        except Exception: detail = str(error)
        raise ValueError(detail) from None
    except URLError:
        raise ValueError('Light Bridge is unavailable. Start launch.py on this computer first.') from None

def schema(properties=None, required=None):
    return {'type':'object','properties':properties or {},'required':required or [],'additionalProperties':False}

S={'type':'string'}
PROJECT={'type':'object','description':'Complete version-1 six-track show. Read lightbridge://guide for schema; unknown editor fields are preserved.'}
TOOLS=[]
def tool(name, description, properties=None, required=None, read=False):
    TOOLS.append({'name':name,'description':description,'inputSchema':schema(properties,required),'annotations':{'readOnlyHint':read,'destructiveHint':not read,'openWorldHint':False}})

tool('lighting_capabilities','Discover supported authoring and playback capabilities. No hardware commands.',read=True)
tool('lighting_discover','Scan the LAN for Govee controllers. Only the configured H7062 six-head set is an animation target.')
tool('lighting_status','Get playback status and loop cycle. Does not prove physical light output.',read=True)
tool('shows_list','List named shows saved on disk.',read=True)
tool('show_get','Read one saved show, or the editor autosave when id is omitted.',{'id':S},read=True)
tool('show_create','Create a new in-memory six-track show, initially Off. Does not save or play.',{'name':S,'duration':{'type':'number','minimum':.1,'maximum':3600}},['name','duration'],True)
tool('show_set_track','Return an edited copy of a show with one track replaced. Does not save or play.',{'project':PROJECT,'track':{'type':'integer','minimum':0,'maximum':5},'keys':{'type':'array','minItems':1,'items':{'type':'object','required':['t','on','intensity','color','ease'],'properties':{'t':{'type':'number','minimum':0},'on':{'type':'boolean'},'intensity':{'type':'number','minimum':0,'maximum':100},'color':{'type':'array','minItems':3,'maxItems':3,'items':{'type':'integer','minimum':0,'maximum':255}},'ease':{'enum':['linear','jump']}},'additionalProperties':True}}},['project','track','keys'],True)
tool('show_validate','Validate a show and evaluate all six heads at a time without touching lights.',{'project':PROJECT,'time':{'type':'number','minimum':0}},['project'],True)
tool('show_save','Save a complete show to disk. Omit id for a new show; existing id overwrites that named show. Does not play or replace the editor.',{'project':PROJECT,'id':S},['project'])
tool('show_play','Explicit physical action: start a saved show on configured floods over LAN. Computer must stay running. Replaces current playback; does not upload a standalone device preset.',{'id':S,'loop':{'type':'boolean'},'position':{'type':'number','minimum':0}},['id'])
tool('lighting_stop','Explicit physical action: stop playback and restore starting shared controller state. Prior per-head effects cannot be restored exactly.')
tool('lighting_loop','Explicit physical action: change looping during playback. Disabling finishes current pass.',{'enabled':{'type':'boolean'}},['enabled'])

def valid_id(value): return str(uuid.UUID(value))
def check_arguments(name,args):
    spec=next((t for t in TOOLS if t['name']==name),None)
    if spec is None: raise ValueError('Unknown tool')
    if not isinstance(args,dict): raise ValueError('Arguments must be an object')
    definition=spec['inputSchema']
    if set(args)-set(definition['properties']): raise ValueError('Unknown argument')
    if set(definition['required'])-set(args): raise ValueError('Missing required argument')
    for key,value in args.items():
        rule=definition['properties'][key];kind=rule.get('type')
        ok={'string':isinstance(value,str),'object':isinstance(value,dict),'array':isinstance(value,list),'boolean':type(value)is bool,'integer':type(value)is int,'number':type(value) in (int,float)}
        if kind and not ok[kind]: raise ValueError('Invalid '+key)
        if kind in ('integer','number'):
            import math
            if not math.isfinite(value) or value<rule.get('minimum',-float('inf')) or value>rule.get('maximum',float('inf')): raise ValueError('Out of range '+key)
    return spec

def call(name,a):
    check_arguments(name,a)
    if name=='lighting_capabilities': return {'target':'configured H7062','tracks':6,'trackIndices':[0,1,2,3,4,5],'transitions':['linear','jump'],'channels':['on','intensity','color'],'playbackHz':10,'standaloneDevicePresetUpload':False,'storage':'local disk','guide':'lightbridge://guide','credentialsExposed':False}
    if name=='lighting_discover': return api('/api/discover',{})
    if name=='lighting_status': return api('/api/status')
    if name=='shows_list': return api('/api/shows')
    if name=='show_get': return api('/api/shows/'+valid_id(a['id'])) if a.get('id') else api('/api/project')
    if name=='show_create':
        p={'version':1,'name':a['name'],'duration':a['duration'],'loop':False,'tracks':[{'name':f'Flood {i+1}','keys':[{'id':str(uuid.uuid4()),'t':0,'on':False,'intensity':0,'color':[0,0,0],'ease':'jump'}]} for i in range(6)]}
        validate_project(p);return p
    if name=='show_set_track':
        p=json.loads(json.dumps(a['project']));validate_project(p)
        p['tracks'][a['track']]['keys']=json.loads(json.dumps(a['keys']))
        for k in p['tracks'][a['track']]['keys']: k['id']=str(uuid.uuid4())
        p['tracks'][a['track']]['keys'].sort(key=lambda k:k['t'])
        validate_project(p);return p
    if name=='show_validate':
        p=validate_project(a['project']);t=a.get('time',0)
        if t>p['duration']: raise ValueError('Time exceeds show duration')
        states=evaluate(p,t)
        return {'valid':True,'duration':p['duration'],'keyCount':sum(len(tr['keys']) for tr in p['tracks']),'states':states,'rgb':[rgb_output(s) for s in states]}
    if name=='show_save':
        validate_project(a['project']);body={'project':a['project']}
        if 'id' in a:body['id']=valid_id(a['id'])
        return api('/api/shows/save',body)
    if name=='show_play':
        p=api('/api/shows/'+valid_id(a['id']));validate_project(p)
        return api('/api/play',{'project':p,'mode':'effect-frames','loop':a.get('loop',False),'position':a.get('position',0)})
    if name=='lighting_stop':return api('/api/stop',{})
    if name=='lighting_loop':return api('/api/loop',{'loop':a['enabled']})

def dispatch(request):
    if not isinstance(request,dict) or request.get('jsonrpc')!='2.0' or not isinstance(request.get('method'),str):
        return {'jsonrpc':'2.0','id':request.get('id') if isinstance(request,dict) else None,'error':{'code':-32600,'message':'Invalid Request'}}
    if 'id' not in request:return None
    ident=request['id'];method=request['method'];params=request.get('params',{})
    if not isinstance(params,dict):return {'jsonrpc':'2.0','id':ident,'error':{'code':-32602,'message':'Params must be an object'}}
    try:
        if method=='initialize':result={'protocolVersion':params.get('protocolVersion') if params.get('protocolVersion') in ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'] else '2025-11-25','capabilities':{'tools':{},'resources':{}},'serverInfo':{'name':'light-bridge','version':'1.0.0'},'instructions':'Read lightbridge://guide. Author/save tools do not play. Only explicit playback tools change physical output. No standalone preset upload.'}
        elif method=='ping':result={}
        elif method=='tools/list':result={'tools':TOOLS}
        elif method=='tools/call':
            try:
                data=call(params['name'],params.get('arguments',{}))
                result={'content':[{'type':'text','text':json.dumps(data,allow_nan=False)}],'isError':False}
            except (ValueError,KeyError,TypeError,IndexError) as error:result={'content':[{'type':'text','text':str(error)}],'isError':True}
        elif method=='resources/list':result={'resources':[{'uri':'lightbridge://guide','name':'Lighting agent guide','mimeType':'text/markdown'}]}
        elif method=='resources/read':
            if params.get('uri')!='lightbridge://guide':raise ValueError('Unknown resource')
            result={'contents':[{'uri':'lightbridge://guide','mimeType':'text/markdown','text':(ROOT/'MCP_GUIDE.md').read_text(encoding='utf-8')}]}
        else:return {'jsonrpc':'2.0','id':ident,'error':{'code':-32601,'message':'Method not found'}}
        return {'jsonrpc':'2.0','id':ident,'result':result}
    except (ValueError,KeyError,TypeError) as error:return {'jsonrpc':'2.0','id':ident,'error':{'code':-32602,'message':str(error)}}

def main():
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    for line in sys.stdin:
        try: response=dispatch(json.loads(line))
        except (ValueError,RecursionError):response={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Parse error'}}
        except Exception:response={'jsonrpc':'2.0','id':None,'error':{'code':-32603,'message':'Internal error'}}
        if response is not None:print(json.dumps(response,ensure_ascii=True,allow_nan=False),flush=True)

if __name__=='__main__':main()
