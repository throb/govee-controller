import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from govee_cloud import GoveeCloud, DEVICES_URL

KEY = 'unit-test-key-not-a-real-credential'

class FakeOpener:
    def __init__(self, value=None, error=None): self.value=value;self.error=error;self.requests=[]
    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.error: raise self.error
        return io.BytesIO(json.dumps(self.value).encode())

class CloudTests(unittest.TestCase):
    def test_connect_reports_capabilities_without_exposing_key(self):
        cloud=GoveeCloud();cloud.opener=FakeOpener({'code':200,'data':[{'sku':'H7062','device':'test-device','deviceName':'Floods','capabilities':[{'type':'devices.capabilities.segment_color_setting','instance':'segmentedColorRgb'}]}]})
        result=cloud.connect(KEY)
        self.assertTrue(result['connected']);self.assertTrue(result['floods'][0]['segmentColor']);self.assertFalse(result['floods'][0]['segmentBrightness'])
        self.assertNotIn(KEY,json.dumps(result));self.assertNotIn('apiKey',result)
        request,timeout=cloud.opener.requests[0];self.assertEqual(request.full_url,DEVICES_URL);self.assertEqual(request.get_header('Govee-api-key'),KEY)
        cloud.disconnect();self.assertIsNone(cloud.key);self.assertEqual(cloud.status(),{'connected':False,'keySaved':False,'deviceCount':0,'floods':[]})
    def test_invalid_header_values_are_rejected_without_network(self):
        cloud=GoveeCloud();cloud.opener=FakeOpener()
        for invalid in ('', 'x', 'validkey\nInjected:secret', None):
            with self.assertRaises(ValueError):cloud.connect(invalid)
        self.assertEqual(cloud.opener.requests,[])
    def test_auth_errors_do_not_echo_remote_messages_or_key(self):
        cloud=GoveeCloud();cloud.opener=FakeOpener(error=urllib.error.HTTPError(DEVICES_URL,401,KEY,{},None))
        with self.assertRaises(ValueError) as error:cloud.connect(KEY)
        self.assertNotIn(KEY,str(error.exception));self.assertIsNone(cloud.key)
    def test_failed_response_does_not_store_key(self):
        cloud=GoveeCloud();cloud.opener=FakeOpener({'code':401,'message':KEY})
        with self.assertRaises(ValueError) as error:cloud.connect(KEY)
        self.assertNotIn(KEY,str(error.exception));self.assertIsNone(cloud.key)

class PersistenceTests(unittest.TestCase):
    def test_encrypted_key_survives_new_process(self):
        import tempfile, subprocess
        from credential_store import CredentialStore
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'key.dpapi'
            store=CredentialStore(path)
            cloud=GoveeCloud(store);cloud.opener=FakeOpener({'code':200,'data':[]})
            cloud.connect(KEY)
            self.assertNotIn(KEY.encode(),path.read_bytes())
            cloud.disconnect()
            self.assertTrue(cloud.status()['keySaved'])
            code="import sys;from credential_store import CredentialStore;assert CredentialStore(sys.argv[1]).load()==sys.argv[2]"
            subprocess.run([sys.executable,'-c',code,str(path),KEY],cwd=Path(__file__).resolve().parents[1],check=True)
            restored=GoveeCloud(store);restored.opener=FakeOpener({'code':200,'data':[]})
            restored.reconnect()
            self.assertTrue(restored.status()['connected'])

if __name__=='__main__':unittest.main()

class SegmentTests(unittest.TestCase):
    def test_segment_control_uses_reported_controller_and_packed_rgb(self):
        cloud=GoveeCloud();cloud.key=KEY
        cloud.devices=[{'sku':'H7062','device':'test-flood'}]
        cloud.opener=FakeOpener({'code':200})
        cloud.segment_color('test-flood',2,[0,255,0])
        request,_=cloud.opener.requests[0]
        body=json.loads(request.data)
        self.assertEqual(body['payload']['capability']['value'],{'segment':[2],'rgb':65280})
        self.assertEqual(body['payload']['device'],'test-flood')
        self.assertNotIn(KEY,request.data.decode())
    def test_cloud_rejection_is_not_reported_as_success(self):
        cloud=GoveeCloud();cloud.key=KEY;cloud.devices=[{'sku':'H7062','device':'test-flood'}]
        cloud.opener=FakeOpener({'code':429})
        with self.assertRaisesRegex(ValueError,'rejected'):cloud.segment_color('test-flood',0,[255,0,0])
