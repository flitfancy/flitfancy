"""Isolated FFV/AstrBot session integration; never opens the real history DB."""
import asyncio
import importlib.util
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
import uuid

from fastapi import FastAPI
from fastapi.testclient import TestClient

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, r'S:\Fireflys\Astrbot\backend\app')
from firefly_sessions import FireflySessions
from install import FFV, patch_ffv
from astrbot.core.utils.session_lock import session_lock_manager


class Events:
    def __init__(self): self.items = []
    def publish(self, kind, data): self.items.append({'type': kind, 'data': data, 'time': time.time()})


class Response:
    def __init__(self, response): self.response = response
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    def raise_for_status(self): self.response.raise_for_status()
    async def json(self): return self.response.json()


class Http:
    def __init__(self, client): self.client = client
    def post(self, url, json): return Response(self.client.post(url.split('7865', 1)[1], json=json))


class Manager:
    def __init__(self, umo):
        self.umo, self.current, self.creations = umo, 'old', 0
        self.rows = [SimpleNamespace(cid='old', user_id=umo, title='旧对话', updated_at=2, created_at=1, persona_id='firefly'),
                     SimpleNamespace(cid='other', user_id='another-owner', title='不可访问', updated_at=1, created_at=1, persona_id='other')]
        self.histories = {'old': [{'role': 'user', 'content': '旧消息'}]}
    async def get_curr_conversation_id(self, umo): return self.current
    async def get_conversations(self, umo): return self.rows[:]
    async def switch_conversation(self, umo, cid): self.current = cid
    async def new_conversation(self, umo, platform_id, persona_id):
        self.creations += 1
        self.current = 'new-' + str(self.creations)
        self.rows.append(SimpleNamespace(cid=self.current, user_id=umo, title='', updated_at=3, created_at=3, persona_id=persona_id))
        self.histories[self.current] = []
        return self.current


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        source = (FFV / 'dialogue_service.py').read_text(encoding='utf-8')
        if 'from ffv_dialogue_sessions import DialogueSessions' not in source:
            source = patch_ffv(source)
        namespace = {'__name__': 'isolated_dialogue'}
        exec(compile(source, '<isolated dialogue>', 'exec'), namespace)
        self.events = Events()
        self.state = {'dialogue': {'last_seen': time.time(), 'protocol': 2}}
        app = FastAPI()
        namespace['register_dialogue_routes'](app, self.state, self.events)
        self.client = TestClient(app)
        self.manager = Manager('qq-test:FriendMessage:100001')
        self.bridge = SimpleNamespace(umo=self.manager.umo, qq_platform='qq-test',
                                      context=SimpleNamespace(conversation_manager=self.manager),
                                      history_lock=asyncio.Lock(), http=Http(self.client))
        async def sync():
            cid = self.manager.current
            response = self.client.post('/v1/dialogue/snapshot', json={'revision': cid,
                'conversation_id': cid, 'messages': self.manager.histories[cid]})
            return response.status_code == 200
        self.bridge._sync_history = sync
        self.sessions = FireflySessions(self.bridge, 'http://127.0.0.1:7865')
        await self.sessions.publish_catalog()
        await sync()

    def submit(self, action, target='', key=None):
        return self.client.post('/v1/dialogue/conversations', json={'action': action,
            'conversation_id': target, 'request_id': key or str(uuid.uuid4())})

    async def test_create_then_resume_old_without_crossing_histories(self):
        key = str(uuid.uuid4())
        self.assertEqual(self.submit('new', key=key).status_code, 202)
        self.assertEqual(self.submit('new', key=key).status_code, 200)
        self.assertEqual(len(self.events.items), 1)
        self.assertEqual(self.client.post('/v1/dialogue/messages', json={'text': 'x', 'request_id': str(uuid.uuid4())}).status_code, 409)
        event = self.events.items[-1]
        await self.sessions.handle(event)
        await self.sessions.handle(event)
        self.assertEqual(self.manager.creations, 1)
        self.assertEqual(self.manager.rows[-1].persona_id, 'firefly')
        snapshot = self.client.get('/v1/dialogue').json()
        self.assertEqual(snapshot['conversation_id'], 'new-1')
        self.assertEqual(snapshot['messages'], [])
        self.assertEqual(snapshot['session_history']['controls'][-1]['phase'], 'complete')
        self.assertEqual(self.submit('select', 'old').status_code, 202)
        await self.sessions.handle(self.events.items[-1])
        snapshot = self.client.get('/v1/dialogue').json()
        self.assertEqual(snapshot['conversation_id'], 'old')
        self.assertEqual(snapshot['messages'][0]['content'], '旧消息')
        self.assertEqual(self.manager.current, 'old')

    async def test_revalidates_owner_even_when_catalog_claims_foreign_id(self):
        self.client.post('/v1/dialogue/conversations/catalog', json={'current_id': 'old',
            'conversations': [{'id': 'other', 'title': 'foreign'}]})
        self.assertEqual(self.submit('select', 'other').status_code, 202)
        await self.sessions.handle(self.events.items[-1])
        self.assertEqual(self.manager.current, 'old')
        self.assertEqual(self.client.get('/v1/dialogue').json()['session_history']['controls'][-1]['phase'], 'error')

    async def test_busy_web_turn_prevents_switch(self):
        key = str(uuid.uuid4())
        self.assertEqual(self.client.post('/v1/dialogue/messages', json={'text': 'hello', 'request_id': key}).status_code, 202)
        self.assertEqual(self.submit('new').status_code, 409)
        self.assertEqual(self.manager.creations, 0)

    async def test_sync_failure_does_not_report_success(self):
        async def fail(): return False
        self.bridge._sync_history = fail
        self.assertEqual(self.submit('new').status_code, 202)
        await self.sessions.handle(self.events.items[-1])
        result = self.client.get('/v1/dialogue').json()['session_history']['controls'][-1]
        self.assertEqual(result['phase'], 'error')
        self.assertIn('可能已切换', result['error'])
        self.assertEqual(self.manager.creations, 1)

    async def test_waits_for_the_same_astrbot_turn_lock(self):
        async with session_lock_manager.acquire_lock(self.bridge.umo):
            self.assertEqual(self.submit('new').status_code, 202)
            task = asyncio.create_task(self.sessions.handle(self.events.items[-1]))
            await asyncio.sleep(0.05)
            self.assertEqual(self.manager.creations, 0)
            self.assertEqual(self.client.get('/v1/dialogue').json()['session_history']['controls'][-1]['phase'], 'running')
        await task
        self.assertEqual(self.manager.creations, 1)


if __name__ == '__main__': unittest.main()
