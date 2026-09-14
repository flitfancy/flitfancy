"""后端拆分模块的快速单元测试；仅使用 Python 标准库。"""

import json
import os
import sqlite3
import socket
import tempfile
import threading
import time
from io import BytesIO
from unittest import mock
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from flitfancy_auth import AdminAuth
from flitfancy_audio import AudioService, AudioServiceError, MAX_AUDIO_BYTES
from flitfancy_core import (
    CST,
    base_url_for_model,
    cfg_bool,
    normalize_protocol_name,
    normalize_reflections,
    now_iso,
)
from flitfancy_observations import normalize_observation, normalize_observation_link
from flitfancy_sensors import (
    normalize_sensor_row,
    parse_sensor_csv_line,
    sensor_row_public,
)
from flitfancy_storage import SQLiteStore
from flitfancy_sync import LatestSensorSyncQueue, WorkerClient


def test_core():
    assert cfg_bool(False) is False
    assert cfg_bool("false") is False
    assert cfg_bool("0") is False
    assert cfg_bool("yes") is True
    assert cfg_bool(None, False) is False
    assert base_url_for_model("qwen-custom", "fallback") == (
        "https://dashscope.aliyuncs.com/compatible-mode/v1"
    )
    assert base_url_for_model("unknown", "fallback") == "fallback"
    assert normalize_reflections([" a ", "a", "", 3, "b"]) == ["a", "b"]
    assert normalize_protocol_name("flitfancy-a1b2c3d4") == "flitfancy-a1b2c3d4"
    assert normalize_protocol_name("flitfancy:fixed") == ""
    assert normalize_protocol_name(None) == ""
    observation, error = normalize_observation({
        "title": "测试星球", "category": "技术与造物", "tags": ["机械", "机械"],
        "summary": "短描述", "content": "正文", "discovered_at": "2026-08-22",
        "source_name": "来源", "source_url": "https://example.com/source", "status": "draft",
    })
    assert error is None and observation["tags"] == ["机械"]
    _, error = normalize_observation({
        "title": "危险来源", "category": "技术与造物", "tags": [],
        "summary": "短描述", "discovered_at": "2026-08-22",
        "source_url": "javascript:alert(1)", "status": "draft",
    })
    assert "http" in error
    _, error = normalize_observation_link({
        "source_uid": "same-observation-uid-0001",
        "target_uid": "same-observation-uid-0001",
        "relation": "类比",
    })
    assert "同一颗" in error
    link_input = {"source_uid": "observation-alpha-0001", "target_uid": "observation-beta-00002", "relation": "类比"}
    assert normalize_observation_link(link_input)[0]["strength"] == "medium"
    for strength in ("weak", "medium", "strong"):
        assert normalize_observation_link(dict(link_input, strength=strength))[0]["strength"] == strength
    for strength in (None, "", "bright", 1):
        assert normalize_observation_link(dict(link_input, strength=strength))[1]


def test_sensors():
    row = normalize_sensor_row({
        "channel": "2",
        "sensor": "AS7341",
        "ok": "1",
        "clear_raw": "42",
        "firmware_version": "v1",
        "custom": {"kept": True},
    }, board="board-a")
    assert row["channel"] == "CH2"
    assert row["board"] == "board-a"
    assert row["ok"] == 1
    assert row["extra"]["clear_raw"] == 42.0
    assert row["extra"]["firmware_version"] == "v1"
    assert row["extra"]["custom"] == {"kept": True}
    public = sensor_row_public(dict(row, id=9))
    assert "id" not in public and "extra" not in public
    assert public["clear_raw"] == 42.0

    parsed = parse_sensor_csv_line(
        "CSV,100,2,0,CH0 SHT41,1,28.5,41.2"
    )
    assert parsed["channel"] == "CH0"
    assert parsed["sensor"] == "CH0 SHT41"
    assert parse_sensor_csv_line("uptime_ms,cycle,channel_index,sensor,ok,temp_c") is None

    future = (datetime.now(CST) + timedelta(days=1)).isoformat()
    clamped = normalize_sensor_row({
        "ts": future, "channel": "CH0", "sensor": "SHT41",
    })["ts"]
    assert abs((datetime.fromisoformat(clamped) - datetime.now(CST)).total_seconds()) < 5


def test_auth():
    config = {"admin_accounts": []}

    def read_config():
        return config

    def save_config(updates):
        config.update(updates)
        return config

    auth = AdminAuth(read_config, save_config)
    password = "test-password-123"
    assert auth.set_password("owner", password, create=True) is True
    assert auth.verify_password("owner", password) is True
    ok, token = auth.login("127.0.0.1", "owner", password)
    assert ok is True and len(token) == 48
    assert auth.token_valid(token, "127.0.0.1") is True
    assert auth.token_valid(token, "127.0.0.2") is False
    auth.logout(token)
    assert auth.token_valid(token, "127.0.0.1") is False
    auth.failures["future-ip"] = [0, time.time() + 24 * 3600]
    ok, message = auth.login("future-ip", "owner", password)
    assert ok is False and "10 分钟" in message


class FakeResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    @staticmethod
    def read():
        return json.dumps({"ok": True}).encode("utf-8")


class FakeOpener:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        return FakeResponse()


def test_sync():
    short_opener = FakeOpener()
    short = WorkerClient(lambda: {
        "worker_admin_url": "https://worker.example",
        "worker_admin_token": "short",
    }, short_opener)
    assert short.ready() is False
    assert short.post("/admin/test", {})[0] is False
    assert short_opener.requests == []

    opener = FakeOpener()
    token = "a" * 32
    client = WorkerClient(lambda: {
        "worker_admin_url": "https://worker.example/",
        "worker_admin_token": token,
    }, opener)
    assert client.post("/admin/test", {"x": 1}) == (True, "")
    request, timeout = opener.requests[0]
    assert request.full_url == "https://worker.example/admin/test"
    assert request.get_header("Authorization") == "Bearer " + token
    assert timeout == 8
    # 老 Worker 的 ok 不能当成新字段已同步；确认值不符也保留待同步。
    assert client.post("/admin/observation-links", {}, expected_response={"strength": "weak"})[0] is False
    with mock.patch.object(FakeResponse, "read", return_value=b'{"ok":true,"strength":"weak"}'):
        assert client.post("/admin/observation-links", {}, expected_response={"strength": "weak"}) == (True, "")
        assert client.post("/admin/observation-links", {}, expected_response={"strength": "strong"})[0] is False

    sent = []
    delivered = threading.Event()

    def sender(rows):
        sent.append(rows)
        delivered.set()

    queue = LatestSensorSyncQueue(lambda: True, sender)
    queue.enqueue([
        {"board": "a", "channel": "CH0", "value": 1},
        {"board": "a", "channel": "CH0", "value": 2},
        {"board": "a", "channel": "CH1", "value": 3},
    ])
    assert delivered.wait(2)
    by_channel = {row["channel"]: row["value"] for row in sent[0]}
    assert by_channel == {"CH0": 2, "CH1": 3}


def test_storage():
    with tempfile.TemporaryDirectory(prefix="flitfancy-modules-") as temp_dir:
        path = os.path.join(temp_dir, "test.db")
        store = SQLiteStore(path, sensor_retention_days=14, prune_interval_seconds=0)
        store.initialize()
        connection = store.connect()
        connection.execute(
            """INSERT INTO sensors(
                ts, board, channel, sensor, ok, temp_c, extra
            ) VALUES(?,?,?,?,?,?,?)""",
            (now_iso(), "board", "CH2", "AS7341", 1, 25.0,
             json.dumps({"f1_415": 100, "clear_raw": 200})),
        )
        old = (datetime.now(CST) - timedelta(days=30)).isoformat()
        connection.execute(
            "INSERT INTO sensors(ts, board, channel, sensor, ok, extra) "
            "VALUES(?,?,?,?,?,?)",
            (old, "board", "OLD", "old", 1, "{}"),
        )
        connection.commit()
        connection.close()
        buckets = store.compute_history_buckets(24, "CH2")
        assert buckets and buckets[0]["f1_415"] == 100.0
        assert store.prune_sensor_history() == 1
        connection = store.connect()
        indexes = {
            row[1] for row in connection.execute("PRAGMA index_list(sensors)")
        }
        connection.close()
        assert "idx_sensors_channel_ts" in indexes

        connection = store.connect()
        connection.execute(
            """INSERT INTO anchors(
                uid, created_at, anchor_time, time_precision, horizon, project,
                title, content, synced
            ) VALUES(?,?,?,?,?,?,?,?,0)""",
            ("pending-anchor-0001", now_iso(), now_iso(), "second", "now",
             "flitfancy", "待补传", "测试存储层补传白名单"),
        )
        connection.commit()
        connection.close()
        pending = store.pending_rows("anchors", 10)
        assert [row["uid"] for row in pending] == ["pending-anchor-0001"]
        store.mark_synced("anchors", "pending-anchor-0001")
        assert store.pending_rows("anchors", 10) == []
        try:
            store.pending_rows("not_allowed", 10)
            raise AssertionError("未知表名必须被补传白名单拒绝")
        except ValueError as exc:
            assert "unknown sync table" in str(exc)

    with tempfile.TemporaryDirectory(prefix="flitfancy-anchor-migration-") as temp_dir:
        path = os.path.join(temp_dir, "legacy.db")
        connection = sqlite3.connect(path)
        connection.execute(
            """CREATE TABLE anchors(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                anchor_time TEXT NOT NULL,
                time_precision TEXT NOT NULL DEFAULT 'second',
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0)"""
        )
        connection.execute(
            """INSERT INTO anchors(
                uid, created_at, anchor_time, time_precision, title, content, synced
            ) VALUES(?,?,?,?,?,?,?)""",
            ("legacy-anchor-0001", now_iso(), now_iso(), "second", "旧锚点", "旧内容", 1),
        )
        connection.commit()
        connection.close()
        connection = sqlite3.connect(path)
        connection.execute("""CREATE TABLE observation_links(
            id INTEGER PRIMARY KEY, uid TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL, source_uid TEXT NOT NULL, target_uid TEXT NOT NULL,
            relation TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0)""")
        connection.execute("INSERT INTO observation_links VALUES(1,'legacy-link','now','now','a','b','延伸',1)")
        connection.commit()
        connection.close()
        store = SQLiteStore(path)
        store.initialize()
        store.initialize()
        connection = store.connect()
        legacy_link = dict(connection.execute("SELECT * FROM observation_links WHERE uid='legacy-link'").fetchone())
        assert legacy_link["strength"] == "medium" and legacy_link["relation"] == "延伸" and legacy_link["synced"] == 1
        migrated = dict(connection.execute(
            "SELECT horizon, project FROM anchors WHERE uid = ?",
            ("legacy-anchor-0001",),
        ).fetchone())
        essay_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(essays)")
        }
        observation_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(observations)")
        }
        observation_link_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(observation_links)")
        }
        connection.close()
        assert migrated == {"horizon": "now", "project": "pending"}
        assert {"uid", "status", "display_order", "synced"} <= essay_columns
        assert {
            "uid", "category", "tags_json", "summary", "content", "discovered_at",
            "source_name", "source_url", "status", "synced",
        } <= observation_columns
        assert {"uid", "source_uid", "target_uid", "relation", "strength", "synced"} <= observation_link_columns


def test_audio():
    received = {}
    first_chunk = threading.Event()

    class AudioStub(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def _json(self, payload, status=200):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/status":
                self._json({"model": "ready", "board_connected": True, "port": "COM5"})
            elif self.path == "/recordings/test.wav":
                body = b"RIFF-test-wave"
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self._json({"detail": "missing"}, 404)

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or 0)
            if "fragmented.wav" in self.path:
                body = self.rfile.read(256)
                first_chunk.set()
                body += self.rfile.read(length - len(body))
            else:
                body = self.rfile.read(length)
            received.update({"path": self.path, "body": body})
            if len(body) == int(self.headers.get("Content-Length") or 0):
                self._json({"accepted": True, "bytes": len(body)})

    server = ThreadingHTTPServer(("127.0.0.1", 0), AudioStub)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    service = AudioService("http://127.0.0.1:%d" % server.server_port)
    try:
        status = service.status()
        assert status["available"] is True and status["port"] == "COM5"
        service.control("mic", "both")
        assert received["path"] == "/mic/both"
        service.control("aec", True)
        assert received["path"] == "/aec/1"
        service.control("aec", False)
        assert received["path"] == "/aec/0"
        service.control("wakeword", True)
        assert received["path"] == "/wakeword/1"
        service.control("wakeword", False)
        assert received["path"] == "/wakeword/0"
        service.control("play-pause")
        assert received["path"] == "/pause-playback"
        service.control("play-resume")
        assert received["path"] == "/resume-playback"
        service.control("device-reboot")
        assert received["path"] == "/device/reboot"
        result = service.upload(BytesIO(b"audio-data"), 10, "../song.flac")
        assert result["bytes"] == 10
        assert received["path"].startswith("/play-file?filename=song.flac")
        assert received["body"] == b"audio-data"
        result = service.upload_firmware(BytesIO(b"f" * 512), 512)
        assert result["bytes"] == 512
        assert received["path"] == "/device/firmware"
        assert received["body"] == b"f" * 512
        try:
            service.upload_firmware(BytesIO(b"short"), 512)
            raise AssertionError("Truncated firmware must fail")
        except AudioServiceError as exc:
            assert exc.status == 400
        try:
            service.upload_firmware(BytesIO(b""), 0x640001)
            raise AssertionError("Oversize firmware must fail before forwarding")
        except AudioServiceError as exc:
            assert exc.status == 413
        reader, writer = socket.socketpair()
        reader.settimeout(2)
        def fragmented_sender():
            with writer:
                writer.sendall(b"a" * 256)
                if first_chunk.wait(1):
                    writer.sendall(b"b" * 256)
        sender = threading.Thread(target=fragmented_sender)
        sender.start()
        try:
            with reader, reader.makefile("rb") as stream:
                result = service.upload(stream, 512, "fragmented.wav")
            assert result["bytes"] == 512
            assert received["body"] == b"a" * 256 + b"b" * 256
        finally:
            sender.join(2)
        connection, response = service.open_recording("test.wav")
        try:
            assert response.read() == b"RIFF-test-wave"
        finally:
            connection.close()
        for action, value in (("mic", "invalid"), ("gain", 3), ("volume", 101),
                              ("transport", "invalid"), ("aec", "true"), ("aec", 1),
                              ("wakeword", "true"), ("wakeword", 1), ("wakeword", None)):
            try:
                service.control(action, value)
                raise AssertionError("非法音频控制参数必须被拒绝")
            except AudioServiceError as exc:
                assert exc.status == 400
        try:
            service.upload(BytesIO(b"x"), MAX_AUDIO_BYTES + 1, "huge.mp3")
            raise AssertionError("超大音频文件必须被拒绝")
        except AudioServiceError as exc:
            assert exc.status == 413
        try:
            AudioService("http://example.com:7865")
            raise AssertionError("音频代理目标必须限制在本机")
        except ValueError:
            pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main():
    test_core()
    test_sensors()
    test_auth()
    test_sync()
    test_storage()
    test_audio()
    print("backend modules test ok")


if __name__ == "__main__":
    main()
