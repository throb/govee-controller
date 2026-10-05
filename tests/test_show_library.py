import copy
import tempfile
import unittest
from pathlib import Path
from show_library import ShowLibrary


class ShowLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name) / 'shows'
        self.library = ShowLibrary(self.directory)
        key = {'t': 0, 'on': True, 'intensity': 9, 'color': [1, 2, 3], 'ease': 'linear'}
        self.project = {'version': 1, 'name': 'My show', 'duration': 12,
                        'tracks': [{'name': f'Flood {i}', 'keys': [copy.deepcopy(key)]} for i in range(6)],
                        'loop': True, 'audioRef': '575daab0-18d0-4279-9b73-9ee89f1a9ce7',
                        'layout': {'fixtures': [{'x': 50, 'y': 50, 'angle': 0} for _ in range(6)]},
                        'editorExtension': {'zoom': 4}}

    def test_round_trip_after_reopening_preserves_entire_document(self):
        result = self.library.save(self.project)
        reopened = ShowLibrary(self.directory)
        self.assertEqual(reopened.load(result['id']), self.project)
        self.assertEqual(reopened.list(), [{k: result[k] for k in ('id', 'name', 'updatedAt')}])

    def test_update_and_save_copy(self):
        first = self.library.save(self.project)
        self.project['name'] = 'Revised'
        self.library.save(self.project, first['id'])
        self.assertEqual(len(self.library.list()), 1)
        second = self.library.save(self.project)
        self.assertNotEqual(first['id'], second['id'])
        self.assertEqual(len(self.library.list()), 2)
        self.assertFalse(list(self.directory.glob('*.tmp')))

    def test_invalid_show_does_not_overwrite_existing(self):
        first = self.library.save(self.project)
        saved = copy.deepcopy(self.project)
        self.project['tracks'][0]['keys'][0]['intensity'] = 101
        with self.assertRaises(ValueError): self.library.save(self.project, first['id'])
        self.assertEqual(self.library.load(first['id']), saved)

    def test_paths_and_names_validated(self):
        for identifier in ('../project', '/tmp/foo', '..', ''):
            with self.assertRaises(ValueError): self.library.load(identifier)
            with self.assertRaises(ValueError): self.library.save(self.project, identifier)
        self.project['name'] = ' '
        with self.assertRaises(ValueError): self.library.save(self.project)
        self.assertEqual(self.library.list(), [])

    def test_invalid_audio_reference_rejected(self):
        self.project['audioRef'] = '../secret'
        with self.assertRaises(ValueError): self.library.save(self.project)


if __name__ == '__main__': unittest.main()
