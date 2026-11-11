"""Public-content outbox: offline recovery and concurrent edits without real data."""
import copy
import importlib
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from flitfancy_sync import PublicContentSyncQueue


class PublicConfigSyncTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {}
        self.lock = threading.RLock()
        self.sent = []
        self.online = False
        self.queue = PublicContentSyncQueue(lambda: self.cfg, self.cfg.update, self.lock, self.send)

    def save(self, updates, timestamp):
        with self.lock:
            current = copy.deepcopy(self.cfg)
            PublicContentSyncQueue.record_changes(current, updates, timestamp)
            current.update(updates)
            self.cfg.clear()
            self.cfg.update(current)

    def send(self, endpoint, payload, *_args):
        self.sent.append((endpoint, copy.deepcopy(payload)))
        return self.online, '' if self.online else 'offline fixture'

    def test_failed_save_survives_restart_and_retries(self):
        self.save({'reflections':['first']}, 100)
        ok, _ = self.queue.flush(['reflections'])
        self.assertFalse(ok)
        self.assertIn('reflections', self.cfg['_public_content_sync']['items'])
        self.online = True
        restarted = PublicContentSyncQueue(lambda: self.cfg, self.cfg.update, self.lock, self.send)
        self.assertTrue(restarted.flush()[0])
        self.assertEqual(self.sent[-1][0], '/admin/content-config')
        self.assertEqual(self.sent[-1][1]['value'], ['first'])
        self.assertEqual(self.cfg['_public_content_sync']['items'], {})

    def test_old_ack_does_not_clear_newer_edit(self):
        self.save({'reflections':['first']}, 100)
        def racing_send(endpoint, payload, *_args):
            self.save({'reflections':['second']}, 101)
            return True, ''
        self.queue.send = racing_send
        self.assertFalse(self.queue.flush(['reflections'])[0])
        self.assertEqual(self.cfg['reflections'], ['second'])
        self.assertIn('reflections', self.cfg['_public_content_sync']['items'])
        self.online = True
        self.queue.send = self.send
        self.assertTrue(self.queue.flush()[0])
        self.assertEqual(self.sent[-1][1]['value'], ['second'])

    def test_only_public_content_is_queued_and_revision_is_monotonic(self):
        self.save({'api_key':'private', 'chat_enabled':False, 'reflections':['a']}, 100)
        first = self.cfg['_public_content_sync']['items']['reflections']['revision']
        self.save({'reflections':['b']}, 10)
        meta = self.cfg['_public_content_sync']
        self.assertGreater(meta['items']['reflections']['revision'], first)
        self.assertEqual(set(meta['items']), {'reflections'})
        self.online = True
        self.queue.flush()
        self.assertNotIn('api_key', repr(self.sent))
        self.assertNotIn('chat_enabled', repr(self.sent))

    def test_real_config_save_persists_retry_marker_with_content(self):
        with tempfile.TemporaryDirectory(prefix='flitfancy-config-sync-') as tmp:
            path = Path(tmp) / 'settings.json'
            with patch.dict(os.environ, {
                'FLITFANCY_AI_CONFIG_PATH': str(path),
                'FLITFANCY_DB_PATH': str(Path(tmp) / 'test.db'),
                'FLITFANCY_SENSOR_RAW_DATA_DIR': str(Path(tmp) / 'sensors'),
            }):
                server = importlib.import_module('server')
                server.ai_config_save({'reflections':['fixture'], 'api_key':'private-fixture'})
                saved = json.loads(path.read_text(encoding='utf-8'))
                self.assertEqual(saved['reflections'], ['fixture'])
                self.assertIn('reflections', saved['_public_content_sync']['items'])
                server._public_content_sync.send = lambda *_args: (False, 'offline')
                self.assertFalse(server.sync_pending_public_config()[0])
                server._public_content_sync.send = lambda *_args: (True, '')
                self.assertTrue(server.sync_pending_public_config()[0])
                saved = json.loads(path.read_text(encoding='utf-8'))
                self.assertEqual(saved['_public_content_sync']['items'], {})
                self.assertEqual(saved['api_key'], 'private-fixture')


if __name__ == '__main__':
    unittest.main(verbosity=2)
