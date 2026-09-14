"""Bounded in-memory shell icon cache; extraction never blocks HTTP or launches an app."""
import base64
import json
import os
import subprocess
import threading
from pathlib import Path


def extract_icons(paths):
    if os.name != "nt" or not paths:
        return {}
    shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    result = subprocess.run(
        [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
         "-File", str(Path(__file__).with_name("launcher_icons.ps1"))],
        input=json.dumps(paths), capture_output=True, text=True, encoding="utf-8",
        timeout=15, check=True, creationflags=subprocess.CREATE_NO_WINDOW,
    )
    values = json.loads(result.stdout)
    icons = {}
    for target in paths:
        value = values.get(target, "")
        if isinstance(value, str) and value and len(value) <= 65536:
            try:
                png = base64.b64decode(value, validate=True)
            except ValueError:
                continue
            if png.startswith(b"\x89PNG\r\n\x1a\n"):
                icons[target] = "data:image/png;base64," + value
    return icons


class IconCache:
    def __init__(self):
        self._lock = threading.Lock()
        self._values = {}
        self._pending = False

    def get(self, paths):
        if os.name != "nt":
            return {}
        with self._lock:
            # Catalogs contain at most 100 saved cards; discard removed paths.
            self._values = {p: value for p, value in self._values.items() if p in paths}
            missing = [p for p in dict.fromkeys(paths) if p not in self._values]
            if missing and not self._pending:
                self._pending = True
                threading.Thread(target=self._load, args=(missing,), daemon=True).start()
            return dict(self._values)

    def _load(self, paths):
        icons = {}
        try:
            icons = extract_icons(paths)
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
        finally:
            with self._lock:
                # Cache failures too, so unavailable icons do not create a polling loop.
                self._values.update({p: icons.get(p, "") for p in paths})
                self._pending = False
