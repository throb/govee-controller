"""Public identity without revealing installation paths or credentials."""
import hashlib
import os
from pathlib import Path

APP_ID = 'light-bridge-studio'

def installation_id(root):
    return hashlib.sha256(os.path.normcase(str(Path(root).resolve())).encode()).hexdigest()[:24]

def matches_installation(identity, root):
    return isinstance(identity, dict) and identity.get('app') == APP_ID and identity.get('installationId') == installation_id(root)
