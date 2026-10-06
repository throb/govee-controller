import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from device_controls import DeviceControls, validate_value, lan_capabilities
from govee_cloud import GoveeCloud

class DeviceControlTests(unittest.TestCase):
    def setUp(self):
        self.net=Mock()
        self.net.inventory.return_value={'devices':[{'id':'bar','model':'H6047','ip':'192.0.2.1'}],'selectedId':None}
        self.net.fresh_state.return_value={'onOff':1,'brightness':40}
        self.cloud=GoveeCloud()
        self.cloud.devices=[{'device':'bar','sku':'H6047','deviceName':'Gaming bars','type':'devices.types.light','capabilities':lan_capabilities()}, {'device':'bulb','sku':'unknown-new-model','type':'devices.types.light','capabilities':lan_capabilities()}]
        self.player=Mock();self.player.operation=threading.RLock();self.player.status.return_value={'playing':True,'controllerIds':['flood-one','flood-two']}
        self.controls=DeviceControls(self.net,self.cloud,self.player)
    def test_inventory_merges_and_supports_unknown_advertised_models(self):
        devices=self.controls.inventory()['devices']
        self.assertEqual(len(devices),2)
        self.assertEqual(devices[0]['name'],'Gaming bars')
        self.assertEqual(devices[0]['source'],'LAN + Govee API')
        self.assertTrue(devices[1]['controlSupported'])
        self.assertFalse(devices[1]['animationSupported'])
    def test_lan_control_does_not_stop_unrelated_show(self):
        result=self.controls.control({'id':'bar','type':'devices.capabilities.range','instance':'brightness','value':40})
        self.net.send.assert_called_once_with('192.0.2.1','brightness',{'value':40})
        self.player.stop.assert_not_called()
        self.assertEqual(result['readback']['state']['brightness'],40)
    def test_playing_target_rejects_commands(self):
        self.player.status.return_value={'playing':True,'controllerIds':['bar']}
        with self.assertRaisesRegex(ValueError,'playing'):self.controls.control({'id':'bar','type':'devices.capabilities.range','instance':'brightness','value':40})
        self.net.send.assert_not_called()
    def test_invalid_values_and_unadvertised_controls_rejected(self):
        for value in (-1,101,True,float('nan')):
            with self.assertRaises(ValueError):self.controls.control({'id':'bar','type':'devices.capabilities.range','instance':'brightness','value':value})
        with self.assertRaises(ValueError):self.controls.control({'id':'bar','type':'unknown','instance':'brightness','value':40})
        self.net.send.assert_not_called()
    def test_struct_segment_validation_and_unknown_fields(self):
        spec={'dataType':'STRUCT','fields':[{'fieldName':'segment','required':True,'dataType':'Array','options':[{'value':0},{'value':1}]},{'fieldName':'rgb','required':True,'dataType':'INTEGER','range':{'min':0,'max':16777215}}]}
        validate_value(spec,{'segment':[0,1],'rgb':255})
        for value in ({'segment':[2],'rgb':255},{'segment':[0]}, {'segment':[0],'rgb':255,'extra':1}):
            with self.assertRaises(ValueError):validate_value(spec,value)
    def test_scene_object_values(self):
        spec={'dataType':'ENUM','options':[{'value':{'id':1,'paramId':2}}]}
        validate_value(spec,{'id':1,'paramId':2})
        with self.assertRaises(ValueError):validate_value(spec,{'id':3,'paramId':2})
    def test_nonlighting_devices_are_visible_readonly(self):
        self.cloud.devices[1]['type']='devices.types.heater'
        self.assertFalse(self.controls.device('bulb')['controlSupported'])

if __name__=='__main__':unittest.main()
