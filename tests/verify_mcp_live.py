import json,subprocess,sys
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=subprocess.Popen([sys.executable,str(root/'mcp_server.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def rpc(method,params={}):
 rpc.i+=1;p.stdin.write(json.dumps({'jsonrpc':'2.0','id':rpc.i,'method':method,'params':params})+'\n');p.stdin.flush();r=json.loads(p.stdout.readline());assert r['id']==rpc.i,r;assert 'error' not in r,r;return r['result']
rpc.i=0
def call(name,args={}):
 r=rpc('tools/call',{'name':name,'arguments':args});assert not r.get('isError'),r;return json.loads(r['content'][0]['text'])
try:
 assert rpc('initialize',{'protocolVersion':'2025-11-25','capabilities':{},'clientInfo':{'name':'verify','version':'1'}})['protocolVersion']=='2025-11-25'
 p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');p.stdin.flush()
 assert len(rpc('tools/list')['tools'])==15
 assert 'Show schema' in rpc('resources/read',{'uri':'lightbridge://guide'})['contents'][0]['text']
 show=call('show_create',{'name':'MCP Blue Amber Example','duration':6})
 for i in range(6):
  keys=[{'t':0,'on':True,'intensity':10+i*3,'color':[0,80,255],'ease':'linear'},{'t':2+i*.1,'on':True,'intensity':55,'color':[255,100,0],'ease':'jump'},{'t':6,'on':False,'intensity':0,'color':[0,0,0],'ease':'jump'}]
  show=call('show_set_track',{'project':show,'track':i,'keys':keys})
 assert call('show_validate',{'project':show,'time':6})['rgb']==[[0,0,0]]*6
 bad=rpc('tools/call',{'name':'show_set_track','arguments':{'project':show,'track':6,'keys':[]}});assert bad['isError']
 call('lighting_status');call('lighting_discover')
 before=call('show_get');saved=call('show_save',{'project':show});assert call('show_get',{'id':saved['id']})==show;assert call('show_get')==before
 (root/'examples').mkdir(exist_ok=True);(root/'examples'/'blue_amber_show.json').write_text(json.dumps(show,indent=2))
 print(json.dumps({'verified':'stdio initialize/tools/resources/create/edit/validate/discover/save/load; current editor preserved','showId':saved['id']}))
finally:
 p.stdin.close();p.wait(timeout=5)
 assert p.returncode==0,p.stderr.read()
