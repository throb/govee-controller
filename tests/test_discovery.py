import sys, threading, unittest
from pathlib import Path
from unittest.mock import Mock, patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server

class DiscoveryTests(unittest.TestCase):
    def test_local_interfaces_exclude_loopback_and_duplicates(self):
        records=[(0,0,0,'',(ip,0)) for ip in ['127.0.0.1','192.0.2.10','192.0.2.10','198.51.100.4']]
        with patch.object(server,'LAN_IP','0.0.0.0'), patch.object(server.socket,'getaddrinfo',return_value=records):
            self.assertEqual(server.local_ipv4_addresses(),['192.0.2.10','198.51.100.4'])
    def test_scan_each_adapter_and_remove_stale_devices(self):
        net=server.Network.__new__(server.Network)
        net.condition=threading.Condition();net.scan_lock=threading.Lock()
        net.interfaces=['192.0.2.10','198.51.100.4'];net.socket=Mock();net.send=Mock()
        net.devices={'stale':{'seen':99,'model':'H7062'}}
        def replies(_):net.devices['fresh']={'seen':101,'model':'H7062'}
        with patch.object(server,'TARGETS',[]),patch.object(server.time,'time',return_value=100),patch.object(server.time,'sleep',side_effect=replies):
            self.assertEqual(net.discover(),[{'seen':101,'model':'H7062'}])
        self.assertEqual(net.send.call_count,6)
        self.assertEqual(net.socket.setsockopt.call_count,6)
        self.assertNotIn('stale',net.devices)
    def test_dead_adapter_does_not_prevent_other_scan(self):
        net=server.Network.__new__(server.Network)
        net.condition=threading.Condition();net.scan_lock=threading.Lock();net.devices={}
        net.interfaces=['192.0.2.10','198.51.100.4'];net.socket=Mock();net.send=Mock()
        net.socket.setsockopt.side_effect=[OSError('unavailable'),None]*3
        with patch.object(server,'TARGETS',[]),patch.object(server.time,'sleep'),patch.object(server,'known_neighbor_addresses',return_value=[]):
            self.assertEqual(net.discover(),[])
        self.assertEqual(net.send.call_count,3)
    def test_neighbors_require_resolved_mac_and_matching_interface(self):
        arp = 'Interface: 192.0.2.10 --- 0x1\n 192.0.2.22 11-22-33-44-55-66 dynamic\n 192.0.2.23 incomplete\n 192.0.2.255 ff-ff-ff-ff-ff-ff static\n 239.255.255.250 01-00-5e-7f-ff-fa static\nInterface: 198.51.100.10 --- 0x2\n 198.51.100.22 11-22-33-44-55-66 dynamic'
        with patch.object(server.subprocess,'run',return_value=Mock(stdout=arp)):
            self.assertEqual(server.known_neighbor_addresses(['192.0.2.10']),['192.0.2.22'])
    def test_receiver_joins_each_interface_without_reuse(self):
        fake=Mock()
        with patch.object(server,'local_ipv4_addresses',return_value=['192.0.2.10','198.51.100.4']),patch.object(server.socket,'socket',return_value=fake),patch.object(server.threading,'Thread'):
            server.Network()
        calls=fake.setsockopt.call_args_list
        joins=[c for c in calls if c.args[1]==server.socket.IP_ADD_MEMBERSHIP and c.args[0]==server.socket.IPPROTO_IP]
        self.assertEqual(len(joins),2)
        self.assertNotIn(unittest.mock.call(server.socket.SOL_SOCKET,server.socket.SO_REUSEADDR,1),calls)

if __name__=='__main__':unittest.main()
