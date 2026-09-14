"""Isolated launcher tests: real files/processes, private temp queue, no user's launch cards."""
import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import threading
import urllib.error
import urllib.request
from dataclasses import fields
from http.server import ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from flitfancy_launcher import LauncherError, LauncherService, normalize_target
from flitfancy_launcher_icons import IconCache, extract_icons
from launcher_agent import launch
from flitfancy_http import HttpDependencies, create_handler


def rejected(work, status=400):
    try:
        work()
    except LauncherError as error:
        assert error.status == status, (error.status, str(error))
    else:
        raise AssertionError("Operation should have been rejected")


def wait_file(path):
    deadline = time.time()+10
    while time.time()<deadline:
        if path.exists():
            return
        time.sleep(.1)
    raise AssertionError("Test process did not create its marker")


with tempfile.TemporaryDirectory(prefix="flitfancy launcher 测试 ") as temp:
    root = Path(temp)
    marker = root/"result.json"
    script = root/"hello world.py"
    script.write_text("import json,sys,os,ctypes\nfrom pathlib import Path\n"
                      "session=ctypes.c_ulong()\n"
                      "if os.name=='nt': ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(),ctypes.byref(session))\n"
                      "Path(sys.argv[1]).write_text(json.dumps({'args':sys.argv[2:],'cwd':os.getcwd(),'session':session.value}),encoding='utf8')\n", encoding="utf8")
    service = LauncherService(root/"private")
    assert service.catalog() == {"ok": True, "cards": [], "jobs": [], "agent_online": False}
    card = service.save({"path": str(script), "args": [str(marker), "你好 世界", "a&b", 'a"b', ""]})["card"]
    assert card["hidden"] is True
    rejected(lambda: service.enqueue("launch", card["id"]), 409)
    rejected(lambda: normalize_target({"path": "relative.py"}))
    rejected(lambda: normalize_target({"path": "https://example.com/run.exe"}))
    rejected(lambda: normalize_target({"path": str(script), "args": "-c evil"}))
    rejected(lambda: normalize_target({"path": str(script), "hidden": "false"}))
    service.claim()
    queued = service.enqueue("launch", card["id"])
    rejected(lambda: service.enqueue("launch", card["id"]), 409)
    with ThreadPoolExecutor(max_workers=4) as pool:
        claimed = list(pool.map(lambda _: service.claim(), range(4)))
    claimed = [job for job in claimed if job]
    assert len(claimed) == 1 and claimed[0]["id"] == queued["job_id"]
    result = launch(claimed[0]["payload"])
    service.finish(queued["job_id"], "done", result)
    wait_file(marker)
    received = json.loads(marker.read_text(encoding="utf8"))
    assert received["args"] == ["你好 世界", "a&b", 'a"b', ""]
    assert Path(received["cwd"]) == root
    assert service.catalog()["jobs"][0]["state"] == "done"
    marker.unlink()
    # Expired pending work is never executed later, even if the desktop agent reconnects.
    with service.connect() as con:
        con.execute("UPDATE jobs SET created=created-20")
    expired = service.enqueue("launch", card["id"])
    with service.connect() as con:
        con.execute("UPDATE jobs SET created=created-20 WHERE id=?", (expired["job_id"],))
    assert service.claim() is None
    assert service.catalog()["jobs"][0]["state"] == "expired"
    queued = service.enqueue("launch", card["id"])
    service.save(dict(card, name="changed"))
    assert service.claim() is None, "Editing cancels stale queued paths"
    service.delete(card["id"])
    assert script.exists() and service.catalog()["cards"] == []
    # Actual HTTP boundaries, including loopback: no anonymous path discovery or execution.
    deps = {field.name: None for field in fields(HttpDependencies)}
    deps.update(launcher_service=service, now_iso=lambda: "test",
                admin_token_valid=lambda token, ip: token == "isolated-launcher-test-token")
    handler = create_handler(HttpDependencies(**deps))
    handler.log_message = lambda *args: None
    http = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True); thread.start()
    def api(endpoint, body=None, headers=None, expected=200):
        req = urllib.request.Request("http://127.0.0.1:%d/api/launcher" % http.server_port + endpoint,
                                     data=None if body is None else (json.dumps(body).encode() if body else b""), headers=headers or {})
        try:
            response = urllib.request.urlopen(req, timeout=5)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            value = json.loads(response.read())
            assert response.status == expected, (response.status, value)
            return value
    try:
        api("", expected=401)
        for endpoint in ("/save", "/delete", "/run", "/pick", "/resolve"):
            api(endpoint, {}, expected=401)
        auth = {"Authorization": "Bearer isolated-launcher-test-token"}
        # These guards reject headers before reading a body. An empty POST avoids
        # Windows resetting the socket while urllib is still sending that body.
        api("/save", {}, dict(auth, **{"Sec-Fetch-Site": "cross-site"}), expected=403)
        api("/save", {}, dict(auth, Origin="https://untrusted.example"), expected=403)
        saved = api("/save", {"path": str(script)}, auth)["card"]
        assert api("", headers=auth)["cards"][0]["path"] == str(script)
        service.claim()
        api("/run", {"path": str(script)}, auth, expected=404)
        api("/run", {"id": saved["id"], "path": "C:/untrusted.exe", "args": ["injected"]}, auth)
        claimed = service.claim()
        assert claimed["payload"]["path"] == str(script) and claimed["payload"]["args"] == []
        service.finish(claimed["id"], "done", {"message": "test"})
        api("/delete", {"id": saved["id"]}, auth)
        assert script.exists()
    finally:
        http.shutdown(); http.server_close(); thread.join()
    # Batch paths with spaces must launch; CMD syntax must not become executable parameters.
    if os.name == "nt":
        batch = root/"write marker.cmd"
        batch.write_text('@echo off\r\necho %~1>batch-result.txt\r\n', encoding="ascii")
        launch({"path": str(batch), "args": ["hello world"]})
        wait_file(root/"batch-result.txt")
        assert (root/"batch-result.txt").read_text().strip() == "hello world"
        for bad in ['x & calc', '%TEMP%', '!VAR!', 'a"b', 'a|b', 'a>file']:
            rejected(lambda: normalize_target({"path": str(batch), "args": [bad]}))
        powershell = root/"write marker.ps1"
        powershell.write_text("param([string]$value)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'ps-result.txt'),$value)\n", encoding="utf-8-sig")
        launch({"path": str(powershell), "args": ["literal & value"]})
        wait_file(root/"ps-result.txt")
        assert (root/"ps-result.txt").read_text() == "literal & value"
        # A real hidden desktop helper consumes the isolated queue in the caller's session.
        session = ctypes.c_ulong()
        ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session))
        if session.value:
            helper = subprocess.Popen([sys.executable, str(Path(__file__).with_name('launcher_agent.py')),
                                       '--state-dir', str(root/'agent')], creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                agent_store = LauncherService(root/'agent')
                deadline = time.time()+10
                while time.time()<deadline and not agent_store.catalog()["agent_online"]:
                    time.sleep(.1)
                assert agent_store.catalog()["agent_online"]
                agent_card = agent_store.save({"path": str(script), "args": [str(marker)]})["card"]
                agent_store.enqueue("launch", agent_card["id"])
                wait_file(marker)
                assert json.loads(marker.read_text())["session"] == session.value
            finally:
                helper.terminate(); helper.wait(timeout=5)
if os.name == "nt":
    # Shell extraction reads an executable's icon without starting that executable.
    assert extract_icons([sys.executable])[sys.executable].startswith("data:image/png;base64,")
    ready, release = threading.Event(), threading.Event()
    def slow_icons(paths):
        ready.set()
        assert release.wait(3)
        return {paths[0]: "cached-icon"}
    cache = IconCache()
    with patch("flitfancy_launcher_icons.extract_icons", side_effect=slow_icons) as extract:
        try:
            assert cache.get(["saved.exe", "missing.exe"]) == {}
            assert ready.wait(3)
            assert cache.get(["saved.exe", "missing.exe"]) == {}, "reads must not wait for extraction"
        finally:
            release.set()
        deadline = time.time()+3
        while time.time()<deadline and not cache.get(["saved.exe", "missing.exe"]):
            time.sleep(.01)
        assert cache.get(["saved.exe", "missing.exe"]) == {"saved.exe": "cached-icon", "missing.exe": ""}
        assert extract.call_count == 1, "cache successful and unavailable icons"
print("launcher: private queue, auth, expiry, native launches and nonblocking icon cache passed")
