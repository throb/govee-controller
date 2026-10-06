"""Opt-in, paired LAN layout editor. Never exposes credentials or desktop APIs."""
import json
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


class TabletSetup:
    def __init__(self, root, snapshot, move, identify, stop, begin_identify=None, end_identify=None):
        self.root, self.snapshot, self.move, self.identify, self.stop = root, snapshot, move, identify, stop
        self.http = None
        self.token = None
        self.expires = 0
        self.lock = threading.RLock()
        self.begin_identify = begin_identify
        self.end_identify = end_identify

    def enable(self, addresses, host='0.0.0.0', port=8766):
        with self.lock:
            self.token = secrets.token_urlsafe(32)
            self.expires = time.time() + 8 * 3600
            expires = self.expires
            def expire():
                with self.lock:
                    if self.expires == expires and self.end_identify:
                        try: self.end_identify()
                        except (ValueError, OSError): pass  # Desktop Exit remains available to retry restoration.
            expiry_timer = threading.Timer(8 * 3600, expire)
            expiry_timer.daemon = True
            expiry_timer.start()
            owner = self
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args): pass
                def reply(self, status, value, content_type='application/json'):
                    data = value if isinstance(value, bytes) else json.dumps(value).encode()
                    self.send_response(status)
                    for name, val in [('Content-Type',content_type),('Content-Length',str(len(data))),('Cache-Control','no-store'),('Referrer-Policy','no-referrer'),('X-Frame-Options','DENY'),('X-Content-Type-Options','nosniff')]: self.send_header(name,val)
                    self.end_headers()
                    self.wfile.write(data)
                def authorized(self):
                    token=self.headers.get('X-LightBridge-Pairing','')
                    return owner.token and time.time()<owner.expires and secrets.compare_digest(token.encode(),owner.token.encode()) and self.headers.get('Sec-Fetch-Site')!='cross-site'
                def do_GET(self):
                    if self.path == '/':
                        self.reply(200,(Path(owner.root)/'tablet.html').read_bytes(),'text/html; charset=utf-8');return
                    if not self.authorized(): self.reply(403,{'error':'Pair from desktop Settings → Lights.'});return
                    if self.path == '/layout': self.reply(200,owner.snapshot())
                    else: self.reply(404,{'error':'Not found'})
                def do_POST(self):
                    if not self.authorized(): self.reply(403,{'error':'Pairing expired. Pair again from desktop.'});return
                    try:
                        size=int(self.headers.get('Content-Length',0))
                        if not 0<size<=4096: raise ValueError('Invalid request size')
                        body=json.loads(self.rfile.read(size))
                        if self.path=='/move': result=owner.move(body)
                        elif self.path=='/identify': result=owner.identify(body)
                        elif self.path=='/identify/start' and owner.begin_identify: result=owner.begin_identify()
                        elif self.path=='/identify/end' and owner.end_identify: result=owner.end_identify()
                        elif self.path=='/stop': result=owner.stop()
                        else: self.reply(404,{'error':'Not found'});return
                        self.reply(200,result)
                    except (ValueError,KeyError,TypeError) as error:self.reply(400,{'error':str(error)})
                    except OSError:self.reply(503,{'error':'Device or storage unavailable'})
            if not self.http:
                self.http=ThreadingHTTPServer((host,port),Handler)
                threading.Thread(target=self.http.serve_forever,daemon=True).start()
            return {'urls':[f'http://{ip}:{self.http.server_port}/#'+self.token for ip in addresses if ip!='0.0.0.0'], 'expires':self.expires}

    def disable(self):
        with self.lock:
            if self.end_identify:self.end_identify()
            self.token=None;self.expires=0
            if self.http:self.http.shutdown();self.http.server_close();self.http=None
        return {'enabled':False}
