import copy, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import Mock, patch
import server
from animation import validate_project

def project(count=2):
    return {'version':1,'duration':.1,'controllers':[{'id':str(i),'model':'H7062'} for i in range(count)],'tracks':[{'keys':[{'t':0,'on':True,'intensity':100,'color':[255 if i<6 else 0,0,255 if i>=6 else 0],'ease':'jump'}]} for i in range(count*6)]}

class MultiControllerTests(unittest.TestCase):
    def test_bindings_and_track_count(self):
        self.assertEqual(len(validate_project(project(9))['tracks']),54)
        self.assertEqual(len(validate_project(project(9))['controllers']),9)
        for value in [project(17), dict(project(),tracks=project()['tracks'][:6]),dict(project(),controllers=[{'id':'same','model':'H7062'}]*2)]:
            with self.assertRaises(ValueError): validate_project(value)
    def test_missing_controller_never_starts_output(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'DATA',Path(temp)):
            net=Mock();net.resolve_controllers.side_effect=ValueError('unavailable')
            player=server.Player(net)
            with self.assertRaisesRegex(ValueError,'unavailable'):player.start({'project':project(),'mode':'effect-frames'})
            net.send.assert_not_called()
    def test_all_states_read_before_worker_start(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'DATA',Path(temp)):
            net=Mock();net.resolve_controllers.return_value=[{'id':'0','ip':'a'},{'id':'1','ip':'b'}]
            net.fresh_state.side_effect=[{'onOff':1},ValueError('offline')]
            player=server.Player(net)
            with self.assertRaisesRegex(ValueError,'offline'):player.start({'project':project(),'mode':'effect-frames'})
            net.send.assert_not_called()
            self.assertFalse(player.status()['playing'])
    def test_two_chunks_and_restores(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'DATA',Path(temp)):
            net=Mock();player=server.Player(net)
            player.state.update(loop=False,stopAt=.1,frames=0)
            targets=[({'id':'0','ip':'a'},{'onOff':1}),({'id':'1','ip':'b'},{'onOff':0})]
            with patch.object(server,'encode_timeline_frame',side_effect=lambda colors:colors):
                player.run_controllers(validate_project(project()),targets,0,server.time.time())
            frames=[c for c in net.send.call_args_list if c.args[1]=='ptReal']
            self.assertEqual(len(frames),2)
            self.assertEqual(frames[0].args,('a','ptReal',{'command':[[255,0,0]]*6}))
            self.assertEqual(frames[1].args,('b','ptReal',{'command':[[0,0,255]]*6}))
            self.assertEqual(net.restore.call_count,2)
            self.assertTrue(player.state['restored'])
    def test_device_colors_do_not_bleed(self):
        with tempfile.TemporaryDirectory() as temp,patch.object(server,'DATA',Path(temp)):
            player=server.Player(Mock())
            player.remember_applied(0,[255,0,0],100,True,'one')
            player.remember_applied(0,[0,0,255],50,True,'two')
            loaded=server.Player(Mock())
            self.assertEqual(loaded.applied_devices['one'][0]['color'],[255,0,0])
            self.assertEqual(loaded.applied_devices['two'][0]['color'],[0,0,255])
