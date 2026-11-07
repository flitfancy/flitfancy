"""Run the existing FFV and voice-plugin regression suites against staged copies."""
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from install import FFV, HERE, VOICE_SOURCE, patch_ffv, patch_voice


def patched(path, marker, patcher):
    text = path.read_text(encoding='utf-8')
    return text if marker in text else patcher(text)


with tempfile.TemporaryDirectory(prefix='firefly-session-regression-') as directory:
    root = Path(directory)
    (root / 'dialogue_service.py').write_text(patched(FFV / 'dialogue_service.py',
        'from ffv_dialogue_sessions import DialogueSessions', patch_ffv), encoding='utf-8')
    for name in ('voice_events.py', 'test_dialogue_service.py'):
        shutil.copy2(FFV / name, root / name)
    shutil.copy2(HERE / 'ffv_dialogue_sessions.py', root / 'ffv_dialogue_sessions.py')
    plugin = root / 'astrbot_plugin_firefly_voice'
    plugin.mkdir()
    for name in ('__init__.py', 'local_provider_policy.py'):
        shutil.copy2(VOICE_SOURCE / name, plugin / name)
    (plugin / 'main.py').write_text(patched(VOICE_SOURCE / 'main.py',
        'from .firefly_sessions import FireflySessions', patch_voice), encoding='utf-8')
    shutil.copy2(HERE / 'firefly_sessions.py', plugin / 'firefly_sessions.py')
    shutil.copy2(FFV / 'integrations' / 'test_astrbot_voice.py', root / 'test_astrbot_voice.py')
    for test in ('test_dialogue_service.py', 'test_astrbot_voice.py'):
        subprocess.run([sys.executable, str(root / test)], cwd=root, check=True)
