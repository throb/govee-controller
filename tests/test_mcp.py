import sys,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import mcp_server as m
class MCPTests(unittest.TestCase):
 def test_authoring_no_hardware(self):
  p=m.call('show_create',{'name':'Test','duration':4});original=copy.deepcopy(p)
  keys=[{'t':0,'on':True,'intensity':100,'color':[255,0,0],'ease':'linear'},{'t':4,'on':False,'intensity':0,'color':[255,0,0],'ease':'jump'}]
  q=m.call('show_set_track',{'project':p,'track':2,'keys':keys})
  self.assertEqual(p,original)
  self.assertEqual(m.call('show_validate',{'project':q,'time':2})['rgb'][2],[128,0,0])
  self.assertEqual(m.call('show_validate',{'project':q,'time':4})['rgb'][2],[0,0,0])
 def test_many_controller_authoring(self):
  p=m.call('show_create',{'name':'54 lights','duration':4})
  p=m.call('show_add_controller',{'project':p,'id':'controller-0','existingDeviceId':'controller-0'})
  for i in range(1,9):p=m.call('show_add_controller',{'project':p,'id':f'controller-{i}'})
  self.assertEqual(len(p['tracks']),54)
  self.assertEqual(len(m.call('show_validate',{'project':p})['states']),54)
  q=m.call('show_set_track',{'project':p,'track':53,'keys':p['tracks'][0]['keys']})
  self.assertEqual(len(q['tracks']),54)
  with self.assertRaises(ValueError):m.call('show_add_controller',{'project':p,'id':'controller-0'})
  with self.assertRaises(ValueError):m.call('show_set_track',{'project':p,'track':54,'keys':p['tracks'][0]['keys']})
 def test_bad_input_is_tool_error(self):
  for name,args in [('show_create',{'name':'x','duration':float('nan')}),('show_get',{'id':'../secret'}),('show_play',{'id':'x','loop':'true'}),('lighting_status',{'apiKey':'forbidden'}),('unknown',{})]:
   result=m.dispatch({'jsonrpc':'2.0','id':1,'method':'tools/call','params':{'name':name,'arguments':args}})
   self.assertTrue(result['result']['isError'])
 def test_protocol(self):
  self.assertIsNone(m.dispatch({'jsonrpc':'2.0','method':'notifications/initialized'}))
  self.assertEqual(m.dispatch({'jsonrpc':'2.0','id':4,'method':'unknown'})['error']['code'],-32601)
  self.assertEqual(m.dispatch([])['error']['code'],-32600)
 def test_tools_have_no_secret_or_arbitrary_request_access(self):
  self.assertEqual(len(m.TOOLS),15)
  for t in m.TOOLS:self.assertFalse({'apiKey','url','path'} & set(t['inputSchema']['properties']))
if __name__=='__main__':unittest.main()
