"""Install the small FFV/AstrBot bridge extension with verified local backups.

This does not start, stop or restart any service and never reads configuration.
"""
from datetime import datetime
import argparse
import hashlib
from pathlib import Path
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
FFV = Path(r'S:\NatureCraft\FIREFLY AUDIO\FFV-transfer')
VOICE_SOURCE = FFV / 'integrations' / 'astrbot_plugin_firefly_voice'
VOICE_INSTALLED = Path.home() / '.astrbot' / 'data' / 'plugins' / 'astrbot_plugin_firefly_voice'
BACKUPS = Path(r'S:\FlitFancy\history-backups')


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Expected existing bridge code was not found exactly once; no files changed')
    return text.replace(old, new, 1)


def patch_ffv(text):
    replacements = [
        ('from fastapi.responses import JSONResponse\n', 'from fastapi.responses import JSONResponse\nfrom ffv_dialogue_sessions import DialogueSessions\n'),
        ("    state['conversation'] = cache\n", "    state['conversation'] = cache\n    sessions = DialogueSessions(app, events, state['dialogue'], cache, requests, read_json)\n"),
        ("                    requests=list(requests.values())[-8:])", "                    requests=list(requests.values())[-8:], session_history=sessions.snapshot())"),
        ("        revision = data.get('revision')\n", "        revision = data.get('revision')\n        conversation_id = data.get('conversation_id', '')\n        if not isinstance(conversation_id, str) or len(conversation_id) > 128:\n            raise HTTPException(400, '对话编号无效')\n"),
        ("        cache.update(ready=True, revision=revision, messages=clean, updated_at=time.time())", "        cache.update(ready=True, revision=revision, messages=clean, conversation_id=conversation_id, updated_at=time.time())"),
        ("        bridge = state['dialogue']\n        if time.time() - bridge['last_seen']", "        bridge = state['dialogue']\n        if sessions.busy():\n            raise HTTPException(409, '正在切换会话，请稍候')\n        if time.time() - bridge['last_seen']"),
    ]
    for old, new in replacements:
        text = replace_once(text, old, new)
    return text


def patch_voice(text):
    replacements = [
        ('from .local_provider_policy import LocalProviderPolicy\n', 'from .local_provider_policy import LocalProviderPolicy\nfrom .firefly_sessions import FireflySessions\n'),
        ('        self.provider_policy = LocalProviderPolicy()\n', '        self.provider_policy = LocalProviderPolicy()\n        self.sessions = FireflySessions(self, BASE)\n'),
        ('        async with self.history_lock:\n            await self._sync_history()\n', '        async with self.history_lock:\n            await self._sync_history()\n            try:\n                await self.sessions.publish_catalog()\n                await self.sessions.flush_result()\n            except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, AttributeError):\n                pass\n'),
        ('            if not cid:return\n', '            if not cid:return False\n'),
        ("json={'revision': revision, 'messages': messages}) as response:\n                response.raise_for_status();await response.read()", "json={'revision': revision, 'messages': messages, 'conversation_id': cid}) as response:\n                response.raise_for_status();await response.read()\n            return True"),
        ("            logger.warning('[Firefly Voice] 对话展示快照暂未同步')\n", "            logger.warning('[Firefly Voice] 对话展示快照暂未同步')\n            return False\n"),
        ("                        if event['type'] not in ('voice.turn.completed', 'dialogue.request'):\n", "                        if event['type'] == 'dialogue.conversation.control':\n                            self.background(self.sessions.handle(event))\n                            continue\n                        if event['type'] not in ('voice.turn.completed', 'dialogue.request'):\n"),
    ]
    for old, new in replacements:
        text = replace_once(text, old, new)
    return text


def plan(ffv=FFV, source=VOICE_SOURCE, installed=VOICE_INSTALLED):
    ffv_main = ffv / 'dialogue_service.py'
    source_main, installed_main = source / 'main.py', installed / 'main.py'
    existing = {p: p.read_bytes() for p in (ffv_main, source_main, installed_main)}
    if existing[source_main] != existing[installed_main]:
        raise RuntimeError('Voice source and installed plugin differ; inspect before changing either')
    updated_ffv = patch_ffv(existing[ffv_main].decode('utf-8-sig')).encode('utf-8')
    updated_voice = patch_voice(existing[source_main].decode('utf-8-sig')).encode('utf-8')
    # Install imported modules before patching either application entry point.
    changes = {ffv / 'ffv_dialogue_sessions.py': (HERE / 'ffv_dialogue_sessions.py').read_bytes(),
               source / 'firefly_sessions.py': (HERE / 'firefly_sessions.py').read_bytes(),
               installed / 'firefly_sessions.py': (HERE / 'firefly_sessions.py').read_bytes(),
               source_main: updated_voice, installed_main: updated_voice, ffv_main: updated_ffv}
    for path in changes:
        if path.exists() and path not in existing:
            raise RuntimeError('Extension already exists; inspect before replacing it')
    return existing, changes


def install():
    original, changes = plan()
    backup = BACKUPS / ('firefly-sessions-' + datetime.now().strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True)
    for index, (path, content) in enumerate(original.items()):
        saved = backup / (str(index) + '-' + path.name)
        saved.write_bytes(content)
        if hashlib.sha256(saved.read_bytes()).digest() != hashlib.sha256(content).digest():
            raise RuntimeError('Backup verification failed; no files changed')
    (backup / 'paths.txt').write_text('\n'.join(str(p) for p in original) + '\n', encoding='utf-8')
    changed = []
    try:
        for path, content in changes.items():
            if path in original and path.read_bytes() != original[path]:
                raise RuntimeError('Bridge changed during installation')
            if path not in original and path.exists():
                raise RuntimeError('Extension appeared during installation')
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
                temp = Path(f.name)
                f.write(content)
            temp.replace(path)
            changed.append(path)
            if path.read_bytes() != content:
                raise RuntimeError('Installed file verification failed')
    except BaseException:
        for path in reversed(changed):
            if path in original:
                path.write_bytes(original[path])
            elif path.exists() and path.read_bytes() == changes[path]:
                path.unlink()
        raise
    print('Installed bridge extension; services were not restarted. Backup:', backup)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.apply:
        install()
    else:
        original, changes = plan()
        print('Bridge patch is applicable to', len(original), 'existing files and', len(changes) - len(original), 'new files; no files changed')
