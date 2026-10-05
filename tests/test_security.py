import json, sys, threading, unittest, urllib.request, urllib.error
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class SecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        cls.port=cls.http.server_port
        cls.patch=patch.object(server,'PORT',cls.port);cls.patch.start()
        cls.thread=threading.Thread(target=cls.http.serve_forever,daemon=True);cls.thread.start()
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.thread.join();cls.patch.stop()
    def request(self,path,headers=None):
        try: return urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{self.port}'+path,headers=headers or {}))
        except urllib.error.HTTPError as e:return e
    def test_private_files_are_not_served(self):
        for path in ['/data/govee-key.dpapi','/data/network.json','/.git/config','/server.py','/../data/project.json','/%2e%2e/data/project.json']:
            with self.request(path) as response:self.assertEqual(response.status,404,path)
    def test_cross_origin_and_rebinding_rejected(self):
        for headers in [{'Origin':'https://evil.example'},{'Host':'evil.example'},{'Sec-Fetch-Site':'cross-site'}]:
            with self.request('/',headers) as response:self.assertEqual(response.status,403)
    def test_response_hardening(self):
        with self.request('/') as response:
            self.assertEqual(response.status,200)
            self.assertEqual(response.headers['X-Frame-Options'],'DENY')
            self.assertEqual(response.headers['X-Content-Type-Options'],'nosniff')
            self.assertEqual(response.headers['Cache-Control'],'no-store')
    def test_mcp_setup_and_guide(self):
        with self.request('/api/mcp/setup') as response:
            setup=json.load(response)
        entry=setup['config']['mcpServers']['light-bridge']
        self.assertEqual(entry, {'command':sys.executable,'args':[str(server.ROOT / 'mcp_server.py')]})
        with self.request('/mcp-guide') as response:
            self.assertEqual(response.status,200)
            self.assertIn(b'lightbridge://guide',response.read())

    def test_stale_tabs_cannot_mutate_or_upload(self):
        with patch.object(server, 'PLAYER') as player:
            for path in ['/api/stop', '/api/save', '/api/audio']:
                for identity in [None, 'old-boot']:
                    headers = {} if identity is None else {'X-LightBridge-Instance':identity}
                    request = urllib.request.Request(f'http://127.0.0.1:{self.port}'+path, data=b'{}', headers=headers)
                    with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(request)
                    self.assertEqual(error.exception.code,409)
                player.stop.assert_not_called()
            player.stop.return_value = {'playing':False}
            request = urllib.request.Request(f'http://127.0.0.1:{self.port}/api/stop', data=b'{}', headers={'X-LightBridge-Instance':server.INSTANCE_ID})
            with urllib.request.urlopen(request) as response: self.assertEqual(response.status,200)
            player.stop.assert_called_once()
    def test_ambiguous_controller_requires_selection(self):
        net=server.Network.__new__(server.Network);net.condition=threading.Condition()
        net.devices={str(i):{'id':str(i),'model':'H7062','ip':f'192.0.2.{i}'} for i in (1,2)}
        with patch.object(server,'FLOOD_ID',''):
            with self.assertRaisesRegex(ValueError,'Multiple H7062'):net.flood()
        with patch.object(server,'FLOOD_ID','2'):self.assertEqual(net.flood()['id'],'2')
    def test_single_controller_auto_selection(self):
        net=server.Network.__new__(server.Network);net.condition=threading.Condition()
        net.devices={'one':{'id':'one','model':'H7062','ip':'192.0.2.1'}}
        with patch.object(server,'FLOOD_ID',''):self.assertEqual(net.flood()['id'],'one')
