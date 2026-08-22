"""后端拆分模块的快速单元测试；仅使用 Python 标准库。"""

import json
import os
import sqlite3
import tempfile
import threading
import time
from datetime import datetime, timedelta

from flitfancy_auth import AdminAuth
from flitfancy_core import (
    CST,
    base_url_for_model,
    cfg_bool,
    normalize_protocol_name,
    normalize_reflections,
    now_iso,
)
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
    assert auth.token_valid(token) is True
    auth.logout(token)
    assert auth.token_valid(token) is False
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
        store = SQLiteStore(path)
        store.initialize()
        connection = store.connect()
        migrated = dict(connection.execute(
            "SELECT horizon, project FROM anchors WHERE uid = ?",
            ("legacy-anchor-0001",),
        ).fetchone())
        essay_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(essays)")
        }
        connection.close()
        assert migrated == {"horizon": "now", "project": "pending"}
        assert {"uid", "status", "display_order", "synced"} <= essay_columns


def main():
    test_core()
    test_sensors()
    test_auth()
    test_sync()
    test_storage()
    print("backend modules test ok")


if __name__ == "__main__":
    main()
