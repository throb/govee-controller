"""Named local shows; retain the entire editor document and its audio reference."""
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from animation import validate_project


class ShowLibrary:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.lock = threading.RLock()

    def path(self, identifier):
        try:
            canonical = str(uuid.UUID(identifier))
        except (ValueError, TypeError, AttributeError):
            raise ValueError('Invalid show ID') from None
        return self.directory / (canonical + '.json')

    def list(self):
        with self.lock:
            items = []
            for path in self.directory.glob('*.json'):
                try:
                    record = json.loads(path.read_text(encoding='utf-8'))
                    if self.path(record['id']) != path: continue
                    items.append({key: record[key] for key in ('id', 'name', 'updatedAt')})
                except (OSError, ValueError, KeyError, TypeError):
                    continue
            return sorted(items, key=lambda item: item['updatedAt'], reverse=True)

    def load(self, identifier):
        with self.lock:
            return json.loads(self.path(identifier).read_text(encoding='utf-8'))['project']

    def save(self, project, identifier=None):
        validate_project(project)
        name = project.get('name', '')
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
            raise ValueError('Give the show a name of 1–120 characters')
        if project.get('audioRef'):
            uuid.UUID(project['audioRef'])
        identifier = str(uuid.uuid4()) if identifier is None else str(uuid.UUID(identifier))
        record = {'id': identifier, 'name': name.strip(),
                  'updatedAt': datetime.now(timezone.utc).isoformat(), 'project': project}
        with self.lock:
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.path(identifier)
            temp = self.directory / (str(uuid.uuid4()) + '.tmp')
            try:
                temp.write_text(json.dumps(record, ensure_ascii=False, allow_nan=False), encoding='utf-8')
                temp.replace(path)
            finally:
                temp.unlink(missing_ok=True)
        return {**{key: record[key] for key in ('id', 'name', 'updatedAt')}, 'saved': True}
