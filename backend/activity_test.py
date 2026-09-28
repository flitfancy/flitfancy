"""Activity archive correctness with synthetic data and isolated local HTTP only."""
from datetime import datetime, timedelta, timezone
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
from unittest.mock import patch

import flitfancy_activity as activity
from flitfancy_activity import ActivityClient, ActivityError, ActivityService, aggregate_day, TZ


def stamp(value):
    return datetime.fromisoformat(value).timestamp()


NOW = stamp("2026-09-26T12:00:00+08:00")
MIDNIGHT = stamp("2026-09-26T00:00:00+08:00")
DAY = datetime.fromtimestamp(NOW, TZ).date()


def event(start, seconds, app=None, status=None):
    return {"id": 7, "timestamp": datetime.fromtimestamp(start, timezone.utc).isoformat(),
            "duration": seconds, "data": {"app": app, "status": status,
                                             "title": "PRIVATE_TITLE_37", "url": "https://private.invalid/PRIVATE_URL_82"}}


class FakeSource:
    def __init__(self):
        self.calls = 0
        self.failure = None
        self.window = [event(NOW - 120, 120, app="editor.exe")]
        self.afk = [event(NOW - 120, 90, status="not-afk"), event(NOW - 30, 30, status="afk")]
        self.host = "test-device-do-not-export"

    def get_info(self):
        self.calls += 1
        if self.failure == "offline":
            raise OSError("SECRET_UNSAFE_ERROR_DO_NOT_EXPORT")
        return {"hostname": self.host}

    def get_buckets(self):
        self.calls += 1
        return {"private-window-bucket": {"hostname": self.host, "type": "currentwindow", "client": "aw-watcher-window"},
                "private-afk-bucket": {"hostname": self.host, "type": "afkstatus", "client": "aw-watcher-afk"}}

    def get_events(self, bucket_id, *, start=None, end=None, limit=activity.MAX_EVENTS):
        self.calls += 1
        if self.failure == "half" and "afk" in bucket_id:
            raise OSError("SECRET_UNSAFE_ERROR_DO_NOT_EXPORT")
        values = self.window if "window" in bucket_id else self.afk
        if start is not None:
            values = [item for item in values if
                      stamp(item["timestamp"]) + item["duration"] >= start.timestamp()
                      and stamp(item["timestamp"]) <= end.timestamp()]
        return sorted(values, key=lambda item: item["timestamp"], reverse=True)[:limit]


def rejected(callback, status=400):
    try:
        callback()
    except ActivityError as error:
        assert error.status == status, (error.status, str(error))
    else:
        raise AssertionError("Expected ActivityError")


def test_intervals():
    convert = lambda entries: [(MIDNIGHT + left, MIDNIGHT + right, app) for left, right, app in entries]
    row = aggregate_day(DAY, convert([(0, 100, "A"), (20, 80, "B"), (20, 80, "B")]),
                        convert([(0, 50, "not-afk"), (40, 100, "afk")]), NOW)
    assert row["active_seconds"] == 40 and row["idle_seconds"] == 60, row
    assert row["observed_seconds"] == 100 and row["unknown_seconds"] == 0, row
    assert row["apps"] == [{"app": "A", "seconds": 20}, {"app": "B", "seconds": 20}], row
    # Pauses between events stay unknown/unobserved; AFK-only coverage is not
    # invented computer use, and the inactive period while reading is idle.
    row = aggregate_day(DAY, convert([(0, 20, "A"), (60, 100, "A")]),
                        convert([(0, 10, "not-afk"), (80, 100, "afk")]), NOW)
    assert [row[key] for key in activity.METRICS] == [10, 60, 20, 30], row
    assert row["status"] == "partial"
    row = aggregate_day(DAY, convert([(0, 100, "reader")]), convert([(0, 100, "afk")]), NOW)
    assert row["status"] == "recorded" and row["active_seconds"] == 0 and row["idle_seconds"] == 100
    # Cross-midnight intervals count only this date. Equal-timestamp overlap is
    # deterministic regardless of response order and never adds duplicate time.
    row = aggregate_day(DAY, convert([(-60, 60, "A"), (-60, 60, "B")]), convert([(-90, 90, "not-afk")]), NOW)
    assert row["active_seconds"] == 60 and row["apps"] == [{"app": "A", "seconds": 60}]
    empty = aggregate_day(DAY, [], [], NOW)
    assert empty["status"] == "no_data" and empty["active_seconds"] is None
    unknown = aggregate_day(DAY, convert([(0, 100, "A")]), convert([(0, 100, "unexpected")]), NOW)
    assert unknown["active_seconds"] == 0 and unknown["unknown_seconds"] == 100
    # Window data past the current time cannot turn a heartbeat into future use.
    row = aggregate_day(DAY, convert([(0, 100, "A")]), convert([(0, 100, "not-afk")]), MIDNIGHT + 50)
    assert row["active_seconds"] == 50


def test_archive():
    with tempfile.TemporaryDirectory(prefix="flitfancy-activity-") as directory:
        path = Path(directory) / "site.sqlite"
        source, clock = FakeSource(), [NOW]
        service = ActivityService(path, client=source, clock=lambda: clock[0], history_days=3)
        assert not path.exists() and source.calls == 0, "constructor must not do I/O"
        initial = service.summary()
        assert source.calls == 0 and initial["today"]["status"] == "not_archived"
        assert initial["source"]["status"] == "loading"
        result = service.sync_once(backfill_limit=1)
        assert result["source"]["status"] == "online" and not result["source"]["stale"], result
        assert result["today"]["active_seconds"] == 90 and result["today"]["idle_seconds"] == 30
        assert result["source"]["window_updated_at"] == NOW
        assert result["archive"]["retention"] == "indefinite"
        assert result["archive"]["recorded_days"] == 1 and result["archive"]["backfill_pending_days"] == 2
        assert result["daily"][-2]["status"] == "no_data" and result["daily"][-3]["status"] == "not_archived"
        assert result["range"]["recorded_days"] == 1 and len(result["daily"]) == 7
        # Aggregate updates are replacement transactions, not appended time.
        service.sync_once(backfill_limit=1)
        assert service.summary()["today"]["active_seconds"] == 90
        assert service.summary()["archive"]["backfill_pending_days"] == 1
        source.window[0]["duration"] = 140
        source.afk[-1]["duration"] = 50
        clock[0] += 20
        updated = service.sync_once(backfill_limit=1)
        assert updated["today"]["observed_seconds"] == 140 and updated["today"]["idle_seconds"] == 50
        assert updated["archive"]["backfill_pending_days"] == 0
        # A half-read or capped response cannot overwrite the last valid day.
        before = updated["today"]
        source.failure = "half"
        source.window = [event(NOW - 120, 1, app="broken")]
        assert service.sync_once()["today"] == before
        assert service.summary()["source"]["status"] == "offline"
        source.failure = None
        source.window = [event(NOW - 100 + i, 1, app="capped") for i in range(3)]
        with patch.object(activity, "MAX_EVENTS", 3):
            assert service.sync_once()["today"] == before
        # A response with invalid duration is a failed source read, not zero use.
        source.window = [event(NOW - 120, float("nan"), app="bad")]
        assert service.sync_once()["today"] == before
        source.window = []
        source.afk = []
        clock[0] += 10
        retained = service.sync_once()
        assert retained["today"] == before, "cleared AW data must not erase archived usage"
        assert retained["source"]["stale"] and retained["source"]["last_success_at"] == NOW + 20
        source.failure = "offline"
        offline = service.sync_once()
        assert offline["today"] == before and offline["source"]["stale"]
        assert "SECRET_UNSAFE" not in json.dumps(offline)
        calls = source.calls
        exported = service.export(30)
        assert exported["range"]["active_seconds"] == 90
        assert source.calls == calls, "summary/export must not fetch AW"
        # State and day summaries survive collector recreation and AW deletion.
        restarted = ActivityService(path, client=source, clock=lambda: clock[0], history_days=3)
        assert restarted.summary()["today"] == before
        assert restarted.summary()["source"]["status"] == "offline"
        assert restarted.summary()["archive"]["backfill_pending_days"] == 0
        clock[0] += 86400 * 500
        historic = restarted.summary(1, end="2026-09-26")
        assert historic["daily"][0] == before and historic["today"]["status"] == "not_archived"
        assert historic["range"]["recorded_days"] == 1
        assert restarted.export(1, end="2026-09-26")["apps"] == [{"app": "editor.exe", "seconds": 90}]
        for invalid in (0, 367, True, 1.5, "7.0", None, "-1"):
            rejected(lambda value=invalid: service.summary(value))
        for invalid in ("2099-01-01", "2026-2-2", "2026-13-01", "", 42):
            rejected(lambda value=invalid: service.summary(end=value))
        output = json.dumps(exported).encode() + path.read_bytes()
        for secret in (b"PRIVATE_TITLE_37", b"PRIVATE_URL_82", b"test-device-do-not-export", b"private-window-bucket", b"SECRET_UNSAFE"):
            assert secret not in output, secret
        with closing(sqlite3.connect(path)) as db:
            assert {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")} == {
                "activity_days", "activity_apps", "activity_meta"}
        service.close()


def test_source_selection_and_partial():
    with tempfile.TemporaryDirectory(prefix="flitfancy-activity-source-") as directory:
        source = FakeSource()
        normal = source.get_buckets()
        source.get_buckets = lambda: {**normal, "other-window": {"type": "currentwindow", "hostname": "other"},
                                     "other-afk": {"type": "afkstatus", "hostname": "other"}}
        service = ActivityService(Path(directory) / "site.db", client=source, clock=lambda: NOW, history_days=0)
        assert service.sync_once(backfill_limit=0)["today"]["active_seconds"] == 90
        source.afk = []
        partial_service = ActivityService(Path(directory) / "partial.db", client=source, clock=lambda: NOW, history_days=0)
        partial = partial_service.sync_once(backfill_limit=0)["today"]
        assert partial["status"] == "partial" and partial["unknown_seconds"] == 120
        source.get_buckets = lambda: {"a": {"type": "currentwindow", "hostname": "first"},
                                     "b": {"type": "afkstatus", "hostname": "second"}}
        missing = partial_service.sync_once(backfill_limit=0)
        assert missing["source"]["status"] == "missing_watchers"
        assert missing["today"] == partial, "never combine unrelated hosts or overwrite archives"
        source.get_buckets = lambda: {**normal, "duplicate-window": normal["private-window-bucket"]}
        assert service.sync_once()["source"]["status"] == "missing_watchers"
        assert activity._app_name(r"C:\private-folder\editor.exe") == "editor.exe"
        assert activity._app_name("https://private.invalid/title") == "未知应用"


def test_nonblocking_reads_and_lifecycle():
    with tempfile.TemporaryDirectory(prefix="flitfancy-activity-thread-") as directory:
        source, entered, release = FakeSource(), threading.Event(), threading.Event()
        service = ActivityService(Path(directory) / "thread.db", client=source, clock=lambda: NOW, history_days=0)
        service.sync_once(backfill_limit=0)
        original = source.get_events
        def blocking(*args, **kwargs):
            entered.set()
            assert release.wait(5)
            return original(*args, **kwargs)
        source.get_events = blocking
        service.start()
        assert entered.wait(2)
        thread = service.thread
        service.start()
        assert service.thread is thread
        start = time.monotonic()
        assert service.summary()["today"]["active_seconds"] == 90
        assert service.export()["apps"]
        assert time.monotonic() - start < 1, "AW reads cannot hold locks needed by webpage reads"
        release.set()
        service.close()
        assert not thread.is_alive()
        disabled_path = Path(directory) / "disabled.db"
        disabled = ActivityService(disabled_path, client=source, enabled=False)
        calls = source.calls
        disabled.start()
        assert disabled.thread is None and not disabled_path.exists()
        assert disabled.sync_once()["source"]["status"] == "disabled"
        assert source.calls == calls


def test_summary_snapshot():
    with tempfile.TemporaryDirectory(prefix="flitfancy-activity-snapshot-") as directory:
        path = Path(directory) / "snapshot.db"
        service = ActivityService(path, client=FakeSource(), clock=lambda: NOW, history_days=0)
        service.sync_once(backfill_limit=0)
        original_db = service._db
        written = []

        class Cursor:
            def __init__(self, cursor):
                self.cursor = cursor

            def fetchall(self):
                rows = self.cursor.fetchall()
                # Commit exactly between the day totals and app rows. WAL
                # permits this write even while a coherent reader is active.
                with closing(sqlite3.connect(path)) as writer:
                    with writer:
                        writer.execute("UPDATE activity_days SET active_seconds=180,observed_seconds=210 WHERE day=?", (DAY.isoformat(),))
                        writer.execute("UPDATE activity_apps SET seconds=180 WHERE day=?", (DAY.isoformat(),))
                written.append(True)
                return rows

        class Connection:
            def __init__(self, db):
                self.db = db

            def execute(self, statement, parameters=()):
                cursor = self.db.execute(statement, parameters)
                if "SELECT * FROM activity_days" in statement and not written:
                    return Cursor(cursor)
                return cursor

        @contextmanager
        def intercepted_db():
            with original_db() as db:
                yield Connection(db)

        service._db = intercepted_db
        snapshot = service.summary(1)
        assert written == [True]
        assert snapshot["today"]["active_seconds"] == 90
        assert sum(app["seconds"] for app in snapshot["today"]["apps"]) == 90, "one response mixed day totals and apps from different commits"
        assert snapshot["range"]["active_seconds"] == sum(app["seconds"] for app in snapshot["apps"])
        subsequent = service.summary(1)
        assert subsequent["today"]["active_seconds"] == 180
        assert sum(app["seconds"] for app in subsequent["today"]["apps"]) == 180


def test_http_bounds():
    for url in ("https://127.0.0.1:5600", "http://192.168.1.2:5600", "http://localhost:5600",
                "http://example.com", "http://127.0.0.1:5600/private", "http://user:pass@127.0.0.1:5600",
                "http://127.0.0.1:5600?redirect=1", "http://127.0.0.1:5600#x", "file:///x"):
        rejected(lambda url=url: ActivityClient(url))
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_GET(self):
            requests.append(self.path)
            if self.path.endswith("info"):
                self.send_response(302)
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
            else:
                body = json.dumps({"large": "x" * 200}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with patch.dict(os.environ, {"http_proxy": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1", "no_proxy": "", "NO_PROXY": ""}):
            client = ActivityClient("http://127.0.0.1:%d" % server.server_port)
            rejected(client.get_info, 503)
            assert requests == ["/api/0/info"], requests
            assert client.get_buckets()["large"] == "x" * 200, "OS proxies must not intercept local AW"
            with patch.object(activity, "MAX_RESPONSE_BYTES", 100):
                rejected(client.get_buckets, 503)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def run():
    test_intervals()
    test_archive()
    test_source_selection_and_partial()
    test_nonblocking_reads_and_lifecycle()
    test_summary_snapshot()
    test_http_bounds()
    print("activity archive tests ok: intervals, privacy, persistence, outages, source bounds, lifecycle")


if __name__ == "__main__":
    run()
