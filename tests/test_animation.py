import unittest
import sys
import base64
import tempfile
import time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from animation import validate_project,evaluate_track,rgb_output,segment_packet
import server

def project(duration=1):
    return {'version':1,'duration':duration,'tracks':[{'name':f'Flood {i+1}','keys':[{'t':0,'on':True,'intensity':30,'color':[255,0,0],'ease':'linear'},{'t':duration,'on':False,'intensity':80,'color':[0,0,255],'ease':'jump'}]} for i in range(6)]}

class FakeNetwork:
    def __init__(self): self.commands=[];self.restored=[]
    def flood(self): return {'ip':'192.0.2.1'}
    def fresh_state(self,ip): return {'onOff':1,'brightness':15,'color':{'r':255,'g':0,'b':0},'colorTemInKelvin':0}
    def send(self,ip,cmd,data): self.commands.append((ip,cmd,data))
    def restore(self,ip,state):
        self.restored.append((ip,state))
        return state

class AnimationTests(unittest.TestCase):
    def test_live_loop_toggle_finishes_current_pass(self):
        net=FakeNetwork()
        with tempfile.TemporaryDirectory() as folder:
            old=server.DATA;server.DATA=Path(folder)
            player=None
            try:
                player=server.Player(net)
                player.start({'project':project(.3),'mode':'effect-frames','loop':True})
                deadline=time.monotonic()+3
                while player.status().get('cycle',0)<2 and time.monotonic()<deadline: time.sleep(.02)
                self.assertTrue(player.status()['playing'])
                self.assertGreaterEqual(player.status()['cycle'],2)
                self.assertGreater(len([c for c in net.commands if c[1]=='ptReal']),3)
                player.set_loop({'loop':False})
                self.assertFalse(player.status()['loop'])
                self.assertTrue(player.status()['playing'])
                player.thread.join(2)
                self.assertFalse(player.status()['playing'])
                self.assertEqual(len(net.restored),1)
                with self.assertRaises(ValueError): player.set_loop({'loop':'yes'})
            finally:
                if player: player.stop()
                server.DATA=old

    def test_midpoint_and_switch(self):
        p=validate_project(project(2));s=evaluate_track(p['tracks'][0],1)
        self.assertEqual(s,{'on':True,'intensity':55,'color':[128,0,128]})
        self.assertEqual(rgb_output(evaluate_track(p['tracks'][0],2)),[0,0,0])
    def test_jump(self):
        p=project(2);p['tracks'][0]['keys'][0]['ease']='jump'
        self.assertEqual(evaluate_track(validate_project(p)['tracks'][0],1.9)['color'],[255,0,0])
    def test_packet_checksum_and_segment_mask(self):
        for i in range(6):
            raw=base64.b64decode(segment_packet(i,[20,30,40]));self.assertEqual(len(raw),20);self.assertEqual(raw[12],1<<i)
            checksum=0
            for b in raw:checksum^=b
            self.assertEqual(checksum,0)
    def test_invalid(self):
        p=project();p['tracks'][0]['keys'].append(dict(p['tracks'][0]['keys'][0]))
        with self.assertRaises(ValueError):validate_project(p)
        with self.assertRaises(ValueError):validate_project({'version':1,'duration':float('nan'),'tracks':[]})
    def test_stop_restores_and_prevents_late_frames(self):
        net=FakeNetwork()
        with tempfile.TemporaryDirectory() as folder:
            old=server.DATA;server.DATA=Path(folder)
            try:
                player=server.Player(net);player.start({'project':project(),'mode':'group'});time.sleep(.52);player.stop();count=len(net.commands);time.sleep(.15)
                self.assertEqual(len(net.commands),count);self.assertEqual(len(net.restored),1);self.assertEqual(net.restored[0][1]['brightness'],15);self.assertFalse(player.status()['playing'])
                self.assertTrue(player.status()['restored'])
            finally:server.DATA=old
    def test_restore_failure_is_reported_and_player_stops(self):
        class OfflineNetwork(FakeNetwork):
            def restore(self,ip,state): raise ValueError('no reply')
        with tempfile.TemporaryDirectory() as folder:
            old=server.DATA;server.DATA=Path(folder)
            try:
                player=server.Player(OfflineNetwork());player.start({'project':project(),'mode':'group'});player.stop()
                self.assertFalse(player.status()['playing'])
                self.assertFalse(player.status()['restored'])
                self.assertIn('no reply',player.status()['error'])
            finally:server.DATA=old
    def test_controller_restore_retries_mismatched_readback(self):
        net=object.__new__(server.Network);commands=[];replies=iter([{'onOff':0,'brightness':40},{'onOff':1,'brightness':15}])
        net.send=lambda ip,cmd,data:commands.append((cmd,data))
        net.fresh_state=lambda ip,timeout:next(replies)
        actual=net.restore('192.0.2.1',{'onOff':1,'brightness':15})
        self.assertEqual(actual,{'onOff':1,'brightness':15})
        self.assertEqual(len(commands),4)
    def test_controller_restore_never_claims_success_without_readback(self):
        net=object.__new__(server.Network);net.send=lambda *args:None
        def no_reply(*args,**kwargs): raise ValueError('no reply')
        net.fresh_state=no_reply
        with self.assertRaisesRegex(ValueError,'could not be confirmed'):
            net.restore('192.0.2.1',{'onOff':1,'brightness':15})
    def test_individual_requires_observation(self):
        net=FakeNetwork()
        with tempfile.TemporaryDirectory() as folder:
            old=server.DATA;server.DATA=Path(folder)
            try:
                player=server.Player(net)
                with self.assertRaises(ValueError):player.start({'project':project(),'mode':'individual'})
                with self.assertRaises(ValueError):player.confirm({'observed':True,'testId':'unknown'})
                self.assertEqual(net.commands,[])
            finally:server.DATA=old

if __name__=='__main__':unittest.main()

class DiscoveryTests(unittest.TestCase):
    def test_live_target_discovers_after_server_restart(self):
        import threading
        net=server.Network.__new__(server.Network)
        net.condition=threading.Condition();net.devices={}
        calls=[]
        def discover():
            calls.append(True)
            net.devices['192.0.2.1']={'id':server.FLOOD_ID,'model':'H7062','ip':'192.0.2.1'}
        net.discover=discover
        self.assertEqual(net.flood()['ip'],'192.0.2.1')
        self.assertEqual(calls,[True])
        net.flood();self.assertEqual(calls,[True])
    def test_no_reply_reports_connection_error(self):
        import threading
        net=server.Network.__new__(server.Network)
        net.condition=threading.Condition();net.devices={};net.discover=lambda:None
        with self.assertRaisesRegex(ValueError,'did not respond'):net.flood()

class ManualTests(unittest.TestCase):
    def test_whole_set_static_color_is_read_back(self):
        from unittest.mock import Mock
        net=Mock();net.flood.return_value={'ip':'192.0.2.1'};net.restore.side_effect=lambda ip,state:state
        with tempfile.TemporaryDirectory() as folder:
            from unittest.mock import patch
            with patch.object(server,'DATA',Path(folder)):
                player=server.Player(net)
                result=player.manual({'target':'all','color':[0,255,0],'intensity':25,'on':True})
                self.assertTrue(result['confirmed']);self.assertEqual(result['state']['color'],{'r':0,'g':255,'b':0})
                self.assertEqual(result['state']['brightness'],25)
                restored=server.Player(net)
                self.assertEqual(restored.applied[1]['color'],[0,255,0])
                restored.remember_applied(1,[0,0,255],10,True)
                again=server.Player(net)
                self.assertEqual(again.applied[1]['color'],[0,0,255])
                self.assertEqual(again.applied[0]['color'],[0,255,0])
                with self.assertRaises(ValueError):player.manual({'target':99,'color':[0,255,0],'intensity':25,'on':True})
