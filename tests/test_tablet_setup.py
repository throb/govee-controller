import json
import sys
import unittest
from pathlib import Path
from urllib.request import Request,urlopen
from urllib.error import HTTPError
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from tablet_setup import TabletSetup

class TabletTests(unittest.TestCase):
    def setUp(self):
        self.service=TabletSetup(Path(__file__).resolve().parents[1],lambda:{'lights':[]},lambda b:b,lambda b:b,lambda:{})
        result=self.service.enable(['127.0.0.1'],host='127.0.0.1',port=0)
        self.base,self.token=result['urls'][0].split('/#')
    def tearDown(self):self.service.disable()
    def request(self,path,token=None,origin=None):
        headers={'X-LightBridge-Pairing':token or ''}
        if origin:headers['Sec-Fetch-Site']=origin
        return urlopen(Request(self.base+path,headers=headers),timeout=2)
    def test_pairing_required_and_no_desktop_api_access(self):
        with self.assertRaises(HTTPError) as e:self.request('/layout')
        self.assertEqual(e.exception.code,403)
        with self.request('/layout',self.token) as r:self.assertEqual(json.load(r),{'lights':[]})
        with self.assertRaises(HTTPError) as e:self.request('/api/cloud/status',self.token)
        self.assertEqual(e.exception.code,404)
    def test_expiry_rotation_and_cross_site_rejected(self):
        with self.assertRaises(HTTPError):self.request('/layout',self.token,'cross-site')
        self.service.enable(['127.0.0.1'],host='127.0.0.1',port=0)
        with self.assertRaises(HTTPError):self.request('/layout',self.token)
        self.service.expires=0
        with self.assertRaises(HTTPError):self.request('/layout',self.service.token)

if __name__=='__main__':unittest.main()
