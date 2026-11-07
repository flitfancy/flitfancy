"""Bounded session controls for the existing loopback-only FFV dialogue bridge."""
import time
import uuid
from collections import OrderedDict

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse


class DialogueSessions:
    def __init__(self, app, events, dialogue, cache, requests, read_json):
        self.events, self.dialogue, self.cache, self.requests = events, dialogue, cache, requests
        self.catalog = {'ready': False, 'current_id': '', 'conversations': [], 'updated_at': 0}
        self.controls = OrderedDict()

        @app.post('/v1/dialogue/conversations/catalog')
        async def catalog(request: Request):
            data = await read_json(request, 1024 * 1024)
            rows, current = data.get('conversations'), data.get('current_id', '')
            if not isinstance(rows, list) or len(rows) > 2000 or not isinstance(current, str) or len(current) > 128:
                raise HTTPException(400, '会话目录无效')
            clean = []
            for row in rows:
                if (not isinstance(row, dict) or not isinstance(row.get('id'), str)
                        or not row['id'] or len(row['id']) > 128
                        or not isinstance(row.get('title'), str) or len(row['title']) > 120):
                    raise HTTPException(400, '会话目录无效')
                clean.append({'id': row['id'], 'title': row['title']})
            self.catalog.update(ready=True, current_id=current, conversations=clean, updated_at=time.time())
            return {'ok': True}

        @app.post('/v1/dialogue/conversations')
        async def control(request: Request):
            data = await read_json(request, 4000)
            action, key, target = data.get('action'), data.get('request_id'), data.get('conversation_id', '')
            try:
                if str(uuid.UUID(key)) != key:
                    raise ValueError()
            except (ValueError, TypeError, AttributeError):
                raise HTTPException(400, '请求编号无效') from None
            if action not in ('new', 'select') or not isinstance(target, str) or len(target) > 128:
                raise HTTPException(400, '会话操作无效')
            if action == 'new' and target or action == 'select' and not target:
                raise HTTPException(400, '会话操作无效')
            self.expire()
            existing = self.controls.get(key)
            if existing:
                if existing['action'] != action or existing['conversation_id'] != target:
                    raise HTTPException(409, '请求编号已使用')
                return existing
            if (time.time() - self.catalog['updated_at'] >= 30 or
                    time.time() - self.dialogue['last_seen'] >= 30 or self.dialogue.get('protocol') != 2):
                raise HTTPException(503, '会话切换服务未连接，请检查 AstrBot 和本机桥接')
            if self.busy() or any(item['phase'] in ('queued', 'thinking') for item in self.requests.values()):
                raise HTTPException(409, '请等待当前对话或会话切换完成')
            if action == 'select' and target not in {row['id'] for row in self.catalog['conversations']}:
                raise HTTPException(404, '会话已不存在，请刷新列表')
            item = {'request_id': key, 'action': action, 'conversation_id': target,
                    'phase': 'queued', 'time': time.time(), 'error': ''}
            self.controls[key] = item
            while len(self.controls) > 64:
                self.controls.popitem(last=False)
            self.events.publish('dialogue.conversation.control', dict(item))
            return JSONResponse(item, status_code=202)

        @app.post('/v1/dialogue/conversations/claim')
        async def claim(request: Request):
            data = await read_json(request, 4000)
            self.expire()
            item = self.controls.get(data.get('request_id'))
            if not item or item['phase'] != 'queued':
                return {'run': False}
            item['phase'] = 'running'
            return {'run': True, 'action': item['action'], 'conversation_id': item['conversation_id'], 'time': item['time']}

        @app.post('/v1/dialogue/conversations/result')
        async def result(request: Request):
            data = await read_json(request, 4000)
            item = self.controls.get(data.get('request_id'))
            phase, error, current = data.get('phase'), data.get('error', ''), data.get('current_id', '')
            if not item or item['phase'] not in ('running', 'uncertain'):
                return {'ok': True, 'ignored': True}
            if phase not in ('complete', 'error') or not isinstance(error, str) or len(error) > 300:
                raise HTTPException(400, '会话结果无效')
            if not isinstance(current, str) or len(current) > 128:
                raise HTTPException(400, '会话结果无效')
            if phase == 'complete' and (not current or self.cache.get('conversation_id') != current or self.catalog['current_id'] != current):
                phase, error = 'error', '会话可能已切换，请等待同步后核对；没有自动重试'
            item.update(phase=phase, error=error, current_id=current)
            return {'ok': True}

    def expire(self):
        now = time.time()
        for item in self.controls.values():
            if item['phase'] == 'queued' and now - item['time'] > 60:
                item.update(phase='error', error='会话请求未执行；请检查 AstrBot 连接')
            elif item['phase'] == 'running' and now - item['time'] > 120:
                item.update(phase='uncertain', error='操作结果暂不确定，请核对会话；没有自动重试')

    def busy(self):
        self.expire()
        return any(item['phase'] in ('queued', 'running', 'uncertain') for item in self.controls.values())

    def snapshot(self):
        self.expire()
        return {**self.catalog, 'connected': time.time() - self.catalog['updated_at'] < 30,
                'controls': list(self.controls.values())[-8:]}
