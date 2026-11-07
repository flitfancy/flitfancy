"""Use AstrBot's existing shared conversation manager; no private history copy."""
import asyncio
import time

from astrbot.core.utils.session_lock import session_lock_manager


class FireflySessions:
    def __init__(self, bridge, base):
        self.bridge, self.base = bridge, base
        self.pending_result = None

    async def post(self, path, payload):
        async with self.bridge.http.post(self.base + path, json=payload) as response:
            response.raise_for_status()
            return await response.json()

    async def publish_catalog(self):
        manager = self.bridge.context.conversation_manager
        current = await manager.get_curr_conversation_id(self.bridge.umo) or ''
        conversations = await manager.get_conversations(self.bridge.umo)
        # The manager returns only this owner's UMO, but check again at the boundary.
        owned = [row for row in conversations if row.user_id == self.bridge.umo]
        owned.sort(key=lambda row: row.updated_at or row.created_at or 0, reverse=True)
        rows = [{'id': row.cid, 'title': (row.title or '未命名对话').strip()[:120] or '未命名对话'}
                for row in owned[:2000]]
        await self.post('/v1/dialogue/conversations/catalog', {'current_id': current, 'conversations': rows})
        return current

    async def flush_result(self):
        if self.pending_result:
            result = self.pending_result
            await self.post('/v1/dialogue/conversations/result', result)
            if self.pending_result is result:
                self.pending_result = None

    async def handle(self, event):
        key = event.get('data', {}).get('request_id', '')
        try:
            claimed = await self.post('/v1/dialogue/conversations/claim', {'request_id': key})
            if not claimed.get('run'):
                return
            phase, error, current = 'error', '操作未完成，请检查服务状态', ''
            if time.time() - float(claimed.get('time', 0)) > 30:
                error = '请求已过期，没有执行；请重新选择会话'
            else:
                changed = False
                try:
                    async with self.bridge.history_lock:
                        cm = session_lock_manager.acquire_lock(self.bridge.umo)
                        await asyncio.wait_for(cm.__aenter__(), timeout=45)
                        try:
                            manager = self.bridge.context.conversation_manager
                            rows = await manager.get_conversations(self.bridge.umo)
                            owned = {row.cid: row for row in rows if row.user_id == self.bridge.umo}
                            if claimed['action'] == 'select':
                                target = claimed['conversation_id']
                                if target not in owned:
                                    raise ValueError('会话不属于当前私聊或已删除')
                                changed = True
                                await manager.switch_conversation(self.bridge.umo, target)
                                current = target
                            elif claimed['action'] == 'new':
                                previous = await manager.get_curr_conversation_id(self.bridge.umo)
                                persona = getattr(owned.get(previous), 'persona_id', None)
                                changed = True
                                current = await manager.new_conversation(
                                    self.bridge.umo, platform_id=self.bridge.qq_platform, persona_id=persona)
                            else:
                                raise ValueError('会话操作无效')
                            synced = await self.bridge._sync_history()
                            catalog_current = await self.publish_catalog()
                            if not synced or catalog_current != current:
                                raise RuntimeError('会话可能已切换，请等待同步后核对；没有自动重试')
                            phase, error = 'complete', ''
                        finally:
                            await cm.__aexit__(None, None, None)
                except asyncio.TimeoutError:
                    error = ('会话可能已切换，请等待同步后核对；没有自动重试' if changed
                             else '正在进行的对话尚未结束，会话没有切换')
                except ValueError as exc:
                    error = ('会话可能已切换，请等待同步后核对；没有自动重试' if changed else str(exc)[:300])
                except Exception:
                    error = ('会话可能已切换，请等待同步后核对；没有自动重试' if changed
                             else '操作未完成，请检查 AstrBot 状态')
            self.pending_result = {'request_id': key, 'phase': phase, 'error': error, 'current_id': current}
            await self.flush_result()
        except Exception:
            # FFV may be offline. Do not replay a possibly completed creation.
            return
