import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from layout_controls import LayoutControls
from animation import validate_project
from test_animation import project

class LayoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'project.json'
        self.p=project();self.p['name']='test';self.p['controllers']=[{'id':'flood','model':'H7062'}]
        self.p['layout']={'fixtures':[{'x':20+i*10,'y':60,'angle':0} for i in range(6)],'lights':[{'deviceId':'bar','model':'H6047','name':'Bars','x':50,'y':30}]}
        self.path.write_text(json.dumps(self.p))
        self.net=Mock();self.player=Mock();self.player.operation=threading.RLock();self.player.status.return_value={'playing':False}
        self.controls=Mock();self.controls.device.return_value={'id':'flood','ip':'192.0.2.1'}
        self.layout=LayoutControls(self.path,self.net,self.player,self.controls)
    def tearDown(self):self.tmp.cleanup()
    def test_all_added_lights_have_known_model_and_identity(self):
        result=self.layout.snapshot();self.assertEqual(len(result['lights']),7)
        self.assertEqual(result['lights'][5]['head'],5);self.assertEqual(result['lights'][6]['model'],'H6047')
    def test_move_preserves_show_and_rejects_stale_edit(self):
        result=self.layout.move({'projectId':'test','key':'device:bar','x':80,'y':20,'revision':0})
        self.assertEqual(result['revision'],1);self.assertEqual(json.loads(self.path.read_text())['tracks'],self.p['tracks'])
        with self.assertRaisesRegex(ValueError,'another screen'):self.layout.move({'projectId':'test','key':'track:0','x':40,'y':30,'revision':0})
    def test_identify_refuses_playing_show(self):
        self.player.status.return_value={'playing':True}
        with self.assertRaisesRegex(ValueError,'Pause'):self.layout.identify({'key':'track:0'})
        self.net.send.assert_not_called()
    def test_identify_restores_even_when_send_fails(self):
        self.net.send.side_effect=OSError('network failed')
        with self.assertRaises(OSError):self.layout.identify({'key':'track:0'})
        self.net.restore.assert_called_once()
    def test_extra_layout_validation(self):
        validate_project(self.p)
        self.p['layout']['lights'][0]['x']=float('nan')
        with self.assertRaises(ValueError):validate_project(self.p)

if __name__=='__main__':unittest.main()
