import json, sys, tempfile, threading, unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server

class DeviceSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)
        self.patches = [patch.object(server, 'DATA', self.data), patch.object(server, 'CONFIG_FILE', self.data / 'network.json'), patch.object(server, 'CONFIG', {'lan_ip':'0.0.0.0'}), patch.object(server, 'FLOOD_ID', 'one')]
        for p in self.patches: p.start()
        self.net = server.Network.__new__(server.Network)
        self.net.condition = threading.Condition()
        self.net.devices = {name:{'id':name, 'ip':f'192.0.2.{i}', 'model':model} for i,(name,model) in enumerate([('one','H7062'),('two','H7062'),('bar','H6047')],1)}
        self.player = server.Player(self.net)
    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()
    def test_inventory_includes_unsupported_and_selected(self):
        inventory = self.net.inventory()
        self.assertEqual(len(inventory['devices']),3)
        self.assertEqual(inventory['selectedId'],'one')
    def test_selection_persists_and_clears_other_device_state(self):
        self.player.confirmed = True
        self.player.calibration_id = 'old'
        self.player.calibration_done = True
        self.player.remember_applied('all',[255,0,0],100,True)
        result = self.player.select_device({'id':'two'})
        self.assertEqual(result['selectedId'],'two')
        self.assertEqual(self.net.flood()['id'],'two')
        self.assertEqual(json.loads(server.CONFIG_FILE.read_text()), {'lan_ip':'0.0.0.0','flood_id':'two'})
        self.assertEqual(self.player.applied,[None]*6)
        self.assertFalse(self.player.confirmed)
        self.assertIsNone(self.player.calibration_id)
        restarted = server.Player(self.net)
        self.assertFalse(restarted.confirmed)
        self.assertFalse(restarted.calibration_done)
        self.assertEqual(restarted.applied,[None]*6)
    def test_unknown_and_unsupported_do_not_change_selection(self):
        for identifier, message in [('missing','not discovered'),('bar','not supported')]:
            with self.assertRaisesRegex(ValueError,message): self.player.select_device({'id':identifier})
        self.assertEqual(server.FLOOD_ID,'one')
        self.assertFalse(server.CONFIG_FILE.exists())
    def test_active_playback_and_restoring_thread_block_switch(self):
        self.player.state['playing'] = True
        with self.assertRaisesRegex(ValueError,'Stop playback'): self.player.select_device({'id':'two'})
        self.player.state['playing'] = False
        self.player.thread = Mock()
        self.player.thread.is_alive.return_value = True
        with self.assertRaisesRegex(ValueError,'Stop playback'): self.player.select_device({'id':'two'})
        self.assertEqual(server.FLOOD_ID,'one')
    def test_same_selection_keeps_applied_colors(self):
        self.player.remember_applied(0,[0,255,0],100,True)
        self.player.select_device({'id':'one'})
        self.assertEqual(self.player.applied[0]['color'],[0,255,0])

if __name__ == '__main__': unittest.main()
