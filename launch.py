"""Reuse an existing studio or run it in this console."""
import json
import runpy
import socket
import threading
import urllib.request
import webbrowser
from pathlib import Path
from app_identity import matches_installation

URL = 'http://127.0.0.1:8765/'
ROOT = Path(__file__).resolve().parent

def running_installation():
    """An occupied port is never permission to open another installation."""
    try:
        with urllib.request.urlopen(URL + 'api/instance', timeout=2) as response:
            identity = json.load(response)
    except (OSError, ValueError):
        try:
            with socket.create_connection(('127.0.0.1', 8765), timeout=1):
                return 'other'
        except OSError:
            return 'none'
    return 'same' if matches_installation(identity, ROOT) else 'other'

def main():
    state = running_installation()
    if state == 'other':
        raise SystemExit('Port 8765 is already used by another or older installation. Stop that server in its console with Ctrl+C, then launch this copy again. No data was changed.')
    if state == 'same':
        webbrowser.open(URL)
        return
    # Open only once our own server reports its identity; a bind failure must
    # not send the user to an unrelated process that won the port race.
    def open_when_ready():
        import time
        for _ in range(30):
            if running_installation() == 'same':
                webbrowser.open(URL)
                return
            time.sleep(0.2)
    threading.Thread(target=open_when_ready, daemon=True).start()
    runpy.run_path(str(ROOT / 'server.py'), run_name='__main__')

if __name__ == '__main__':
    main()
