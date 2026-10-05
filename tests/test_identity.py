import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import launch
import mcp_server
from app_identity import APP_ID, installation_id


class IdentityTests(unittest.TestCase):
    def identity(self, root):
        return {'app': APP_ID, 'installationId': installation_id(root), 'instanceId': 'boot-1'}

    def test_launcher_reuses_only_same_installation(self):
        for root, expected in [(launch.ROOT, 'same'), (launch.ROOT / 'other', 'other')]:
            with patch.object(launch.urllib.request, 'urlopen', return_value=io.BytesIO(json.dumps(self.identity(root)).encode())):
                self.assertEqual(launch.running_installation(), expected)

    def test_legacy_server_is_not_reused(self):
        with patch.object(launch.urllib.request, 'urlopen', side_effect=OSError), patch.object(launch.socket, 'create_connection', return_value=io.BytesIO()):
            self.assertEqual(launch.running_installation(), 'other')

    def test_launcher_does_not_open_or_start_over_other_server(self):
        with patch.object(launch, 'running_installation', return_value='other'), patch.object(launch.webbrowser, 'open') as browser, patch.object(launch.runpy, 'run_path') as run:
            with self.assertRaises(SystemExit): launch.main()
            browser.assert_not_called()
            run.assert_not_called()

    def test_mcp_refuses_mutation_of_other_installation(self):
        with patch.object(mcp_server, 'urlopen', return_value=io.BytesIO(json.dumps(self.identity(launch.ROOT / 'other')).encode())) as request:
            with self.assertRaisesRegex(ValueError, 'different Light Bridge'):
                mcp_server.api('/api/stop', {})
            self.assertEqual(request.call_count, 1)

    def test_mcp_sends_boot_identity_on_mutation(self):
        with patch.object(mcp_server, 'urlopen', side_effect=[io.BytesIO(json.dumps(self.identity(mcp_server.ROOT)).encode()), io.BytesIO(b'{}')]) as request:
            mcp_server.api('/api/stop', {})
            self.assertEqual(request.call_args.args[0].get_header('X-lightbridge-instance'), 'boot-1')
