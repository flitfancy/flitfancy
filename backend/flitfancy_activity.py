"""Private ActivityWatch summaries, archived indefinitely in the site's SQLite DB.

Only app names, AFK states and interval timestamps enter the calculation. Window
titles, URLs and raw events are never stored. The collector runs independently
of browser visits; reads and exports use the local archive only.
"""
from __future__ import annotations

from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, time as day_time, timedelta, timezone
import hashlib
import heapq
import ipaddress
import json
import math
from pathlib import Path
import re
import socket
import sqlite3
import threading
import time
import urllib.parse
import urllib.request


TZ = timezone(timedelta(hours=8), "Asia/Shanghai")
MAX_EVENTS = 20000
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
STALE_SECONDS = 90
METRICS = ("active_seconds", "observed_seconds", "idle_seconds", "unknown_seconds")


class ActivityError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class _MissingWatchers(ActivityError):
    pass


def _checked_url(value):
    try:
        url = urllib.parse.urlsplit(value)
        host = url.hostname
        address = ipaddress.ip_address(host)
        port = url.port or 80
        if (url.scheme != "http" or not address.is_loopback or url.username is not None
                or url.password is not None or url.path not in ("", "/")
                or url.query or url.fragment or not 1 <= port <= 65535):
            raise ValueError()
        return "http://%s:%d" % (("[%s]" % host) if address.version == 6 else host, port)
    except (TypeError, ValueError):
        raise ActivityError("ActivityWatch 地址必须是本机回环 HTTP 地址") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ActivityError("ActivityWatch 响应不可用", 503)


class ActivityClient:
    """Read-only bounded requests; proxy settings and redirects are not used."""
    def __init__(self, source_url):
        self.base = _checked_url(source_url)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())

    def _get(self, route, params=None):
        query = "?" + urllib.parse.urlencode(params) if params else ""
        request = urllib.request.Request(self.base + "/api/0/" + route + query,
                                         headers={"Accept": "application/json"})
        try:
            with self.opener.open(request, timeout=3) as response:
                data = response.read(MAX_RESPONSE_BYTES + 1)
            if len(data) > MAX_RESPONSE_BYTES:
                raise ActivityError("ActivityWatch 数据量超出单次读取上限，已保留原归档", 503)
            return json.loads(data)
        except ActivityError:
            raise
        except Exception:
            # Transport exceptions can contain full URLs or response bodies.
            raise ActivityError("ActivityWatch 暂时不可用，已保留本地归档", 503) from None

    def get_info(self):
        return self._get("info")

    def get_buckets(self):
        return self._get("buckets/")

    def get_events(self, bucket_id, *, start=None, end=None, limit=MAX_EVENTS):
        params = {"limit": limit}
        if start is not None:
            params["start"] = start.isoformat()
        if end is not None:
            params["end"] = end.isoformat()
        return self._get("buckets/" + urllib.parse.quote(bucket_id, safe="") + "/events", params)


def _timestamp(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ActivityError("ActivityWatch 记录格式不完整，已保留原归档", 503)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError()
        stamp = parsed.timestamp()
        if not math.isfinite(stamp):
            raise ValueError()
        return stamp
    except (ValueError, OverflowError, OSError):
        raise ActivityError("ActivityWatch 记录时间无效，已保留原归档", 503) from None


def _app_name(value):
    if not isinstance(value, str) or "://" in value:
        return "未知应用"
    # Some watchers use executable paths. Keep only the executable basename.
    value = value.replace("\\", "/").rsplit("/", 1)[-1]
    value = re.sub(r"[\x00-\x1f\x7f-\x9f]", "", value).strip()
    return value[:128] or "未知应用"


def _events(raw, kind, *, capped=True):
    if not isinstance(raw, list) or (capped and len(raw) >= MAX_EVENTS):
        raise ActivityError("ActivityWatch 记录未完整读取，已保留原归档", 503)
    result = []
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("data"), dict):
            raise ActivityError("ActivityWatch 记录格式不完整，已保留原归档", 503)
        stamp = _timestamp(item.get("timestamp"))
        duration = item.get("duration")
        if (isinstance(duration, bool) or not isinstance(duration, (int, float))
                or not math.isfinite(duration) or not 0 <= duration <= 86400 * 366 * 10):
            raise ActivityError("ActivityWatch 记录时长无效，已保留原归档", 503)
        label = _app_name(item["data"].get("app")) if kind == "window" else item["data"].get("status")
        if kind != "window" and label not in ("afk", "not-afk"):
            # Unknown AFK states leave their interval unclassified.
            label = "unknown"
        result.append((stamp, stamp + duration, label))
    return result


def _day_bounds(day):
    start = datetime.combine(day, day_time(), TZ)
    return start.timestamp(), (start + timedelta(days=1)).timestamp()


def aggregate_day(day, windows, afk, until):
    """Intersect window coverage and AFK intervals with one sweep.

    Latest-starting window wins if windows overlap; app name is a stable tie
    breaker. AFK overrides not-AFK on conflicting overlaps. Gaps are never filled.
    Input tuples contain only (start, end, app/status), never event bodies.
    """
    start, finish = _day_bounds(day)
    finish = min(finish, until)
    points = defaultdict(list)
    for index, (left, right, app) in enumerate(windows):
        left_clip, right_clip = max(start, left), min(finish, right)
        if right_clip > left_clip:
            points[left_clip].append(("window+", index, (-left, app, index)))
            points[right_clip].append(("window-", index, None))
    for left, right, status in afk:
        if status not in ("afk", "not-afk"):
            continue
        left, right = max(start, left), min(finish, right)
        if right > left:
            points[left].append((status, 1, None))
            points[right].append((status, -1, None))
    marks = sorted(points)
    heap, present, counts = [], set(), {"afk": 0, "not-afk": 0}
    totals = {key: 0.0 for key in METRICS}
    apps = defaultdict(float)
    for index, stamp in enumerate(marks):
        for kind, value, extra in points[stamp]:
            if kind == "window+":
                present.add(value)
                heapq.heappush(heap, extra)
            elif kind == "window-":
                present.discard(value)
            else:
                counts[kind] += value
        while heap and heap[0][2] not in present:
            heapq.heappop(heap)
        if index + 1 == len(marks) or not heap:
            continue
        seconds = marks[index + 1] - stamp
        totals["observed_seconds"] += seconds
        if counts["afk"]:
            totals["idle_seconds"] += seconds
        elif counts["not-afk"]:
            totals["active_seconds"] += seconds
            apps[heap[0][1]] += seconds
        else:
            totals["unknown_seconds"] += seconds
    # A watcher can return an event touching a boundary or a zero-duration
    # heartbeat. It proves source availability, but is not measured usage.
    has_window = any(left < finish and right > start for left, right, _ in windows)
    has_afk = any(left < finish and right > start for left, right, _ in afk)
    status = ("no_data" if not has_window and not has_afk else
              "partial" if not has_window or not has_afk or totals["unknown_seconds"] > 0.001 else "recorded")
    return {"date": day.isoformat(), "status": status,
            **{key: None if status == "no_data" else round(value, 3) for key, value in totals.items()},
            "apps": [{"app": app, "seconds": round(seconds, 3)}
                     for app, seconds in sorted(apps.items(), key=lambda item: (-item[1], item[0]))]}


class ActivityService:
    def __init__(self, db_path, source_url="http://127.0.0.1:5600", poll_seconds=10,
                 history_days=90, enabled=True, clock=time.time, client=None):
        self.db_path = str(db_path)
        self.source_url = _checked_url(source_url)
        self.poll_seconds = max(2, min(3600, float(poll_seconds)))
        self.history_days = max(0, min(3660, int(history_days)))
        self.enabled, self.clock, self.client = bool(enabled), clock, client
        self._schema_ready = False
        self._db_lock = threading.Lock()
        self._sync_lock = threading.Lock()
        self._lifecycle_lock = threading.Lock()
        self._stop = threading.Event()
        self.thread = None

    @contextmanager
    def _db(self):
        with self._db_lock:
            if not self._schema_ready:
                Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
            connection = sqlite3.connect(self.db_path, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA busy_timeout=5000")
            if not self._schema_ready:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.executescript("""
                    CREATE TABLE IF NOT EXISTS activity_days (
                        source TEXT NOT NULL, day TEXT NOT NULL, status TEXT NOT NULL,
                        active_seconds REAL, observed_seconds REAL, idle_seconds REAL,
                        unknown_seconds REAL, collected_at REAL NOT NULL,
                        window_updated_at REAL, afk_updated_at REAL,
                        PRIMARY KEY (source, day));
                    CREATE TABLE IF NOT EXISTS activity_apps (
                        source TEXT NOT NULL, day TEXT NOT NULL, app TEXT NOT NULL,
                        seconds REAL NOT NULL, PRIMARY KEY (source, day, app));
                    CREATE TABLE IF NOT EXISTS activity_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                """)
                connection.commit()
                self._schema_ready = True
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _get_meta(connection, key, default=None):
        row = connection.execute("SELECT value FROM activity_meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def _put_meta(connection, key, value):
        connection.execute("INSERT OR REPLACE INTO activity_meta(key,value) VALUES(?,?)",
                           (key, json.dumps(value, ensure_ascii=False, separators=(",", ":"))))

    def start(self):
        if not self.enabled:
            return
        with self._lifecycle_lock:
            if self.thread and self.thread.is_alive():
                return
            self._stop.clear()
            self.thread = threading.Thread(target=self._run, name="activity-archive", daemon=True)
            self.thread.start()

    def close(self):
        self._stop.set()
        thread = self.thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=15)

    def _run(self):
        while not self._stop.is_set():
            try:
                self.sync_once()
            except Exception:
                # Disk/source failures must not kill the website or print data.
                pass
            self._stop.wait(self.poll_seconds)

    def _pair(self):
        if self.client is None:
            self.client = ActivityClient(self.source_url)
        info, buckets = self.client.get_info(), self.client.get_buckets()
        if not isinstance(info, dict) or not isinstance(buckets, dict) or len(buckets) > 2000:
            raise ActivityError("ActivityWatch 数据源信息不可用", 503)
        hosts = defaultdict(lambda: {"currentwindow": [], "afkstatus": []})
        for bucket_id, bucket in buckets.items():
            if not isinstance(bucket_id, str) or len(bucket_id) > 512 or not isinstance(bucket, dict):
                continue
            kind, hostname = bucket.get("type"), bucket.get("hostname")
            if kind in ("currentwindow", "afkstatus") and isinstance(hostname, str) and hostname.strip():
                hosts[hostname.strip().casefold()][kind].append((bucket_id, bucket.get("client")))
        pairs = {host: pair for host, pair in hosts.items() if all(pair.values())}
        preferred = [str(info.get("hostname") or "").casefold(), socket.gethostname().casefold()]
        host = next((name for name in preferred if name in pairs), None)
        if host is None and len(pairs) == 1:
            host = next(iter(pairs))
        if host is None:
            raise _MissingWatchers("未找到同一台电脑的前台应用与离开状态记录", 503)
        selected = []
        for kind, client_name in (("currentwindow", "aw-watcher-window"), ("afkstatus", "aw-watcher-afk")):
            matches = pairs[host][kind]
            standard = [pair for pair in matches if pair[1] == client_name]
            choices = standard or matches
            if len(choices) != 1:
                raise _MissingWatchers("存在多组电脑记录，请先在 ActivityWatch 中确认采集源", 503)
            selected.append(choices[0][0])
        source = hashlib.sha256((self.source_url + "\n" + host + "\n" + "\n".join(selected)).encode()).hexdigest()
        return source, selected

    def _read_day(self, day, pair, now):
        start, finish = _day_bounds(day)
        start_dt = datetime.fromtimestamp(start, timezone.utc)
        end_dt = datetime.fromtimestamp(min(finish, now), timezone.utc)
        # AW's start/end query includes intervals crossing the boundaries, as
        # verified against aw-server 0.13.2; clipping below handles midnight.
        windows = _events(self.client.get_events(pair[0], start=start_dt, end=end_dt, limit=MAX_EVENTS), "window")
        afk = _events(self.client.get_events(pair[1], start=start_dt, end=end_dt, limit=MAX_EVENTS), "afk")
        row = aggregate_day(day, windows, afk, now)
        freshness = {"window_updated_at": max((min(now, end) for _, end, _ in windows), default=None),
                     "afk_updated_at": max((min(now, end) for _, end, _ in afk), default=None)}
        return row, freshness

    def _save_day(self, source, row, freshness, now):
        with self._db() as db:
            previous = db.execute("SELECT status,observed_seconds,active_seconds,idle_seconds FROM activity_days WHERE source=? AND day=?",
                                  (source, row["date"])).fetchone()
            # Source retention, cleared buckets, or temporary holes must not
            # replace a measured historical day with a misleading empty day.
            if previous and previous[0] != "no_data" and row["status"] == "no_data":
                return False
            if previous and ((row["observed_seconds"] or 0) + 0.001 < (previous[1] or 0)
                             or (row["active_seconds"] or 0) + (row["idle_seconds"] or 0) + 0.001
                             < (previous[2] or 0) + (previous[3] or 0)):
                # A watcher whose stored history shrank cannot replace already
                # observed/known intervals. Normal AFK revisions may still move
                # time between active and idle without losing known coverage.
                return False
            db.execute("""INSERT OR REPLACE INTO activity_days
                (source,day,status,active_seconds,observed_seconds,idle_seconds,unknown_seconds,
                 collected_at,window_updated_at,afk_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)""",
                       (source, row["date"], row["status"], *(row[key] for key in METRICS), now,
                        freshness["window_updated_at"], freshness["afk_updated_at"]))
            db.execute("DELETE FROM activity_apps WHERE source=? AND day=?", (source, row["date"]))
            db.executemany("INSERT INTO activity_apps(source,day,app,seconds) VALUES(?,?,?,?)",
                           [(source, row["date"], item["app"], item["seconds"]) for item in row["apps"]])
            return True

    def _pending(self, db, source, floor, today):
        queried = {row[0] for row in db.execute("SELECT day FROM activity_days WHERE source=? AND day>=? AND day<?",
                                               (source, floor, today.isoformat()))}
        start = date.fromisoformat(floor)
        return [(today - timedelta(days=offset)).isoformat()
                for offset in range(1, max(0, (today - start).days) + 1)
                if (today - timedelta(days=offset)).isoformat() not in queried]

    def sync_once(self, backfill_limit=2):
        if not self.enabled:
            return self.summary()
        limit = max(0, min(10, int(backfill_limit)))
        with self._sync_lock:
            now = self.clock()
            today = datetime.fromtimestamp(now, TZ).date()
            with self._db() as db:
                state = self._get_meta(db, "state", {})
            state.update(last_checked_at=now)
            try:
                source, pair = self._pair()
                row, freshness = self._read_day(today, pair, now)
                # Both current-day watcher reads completed before any day write.
                saved = self._save_day(source, row, freshness, now)
                for index, key in enumerate(("window_updated_at", "afk_updated_at")):
                    if freshness[key] is None:
                        latest = _events(self.client.get_events(pair[index], limit=1), "window" if index == 0 else "afk", capped=False)
                        freshness[key] = max((min(now, end) for _, end, _ in latest), default=None)
                state.update(status="online", message="已连接 ActivityWatch，本地汇总持续归档" if saved else "当前记录不完整，已保留最近完整汇总",
                             retained_previous=not saved, **freshness)
                if saved:
                    state["last_success_at"] = now
                with self._db() as db:
                    self._put_meta(db, "active_source", source)
                    self._put_meta(db, "state", state)
                    progress = self._get_meta(db, "progress:" + source, {})
                    progress.setdefault("floor", (today - timedelta(days=self.history_days)).isoformat())
                    pending = self._pending(db, source, progress["floor"], today)
                yesterday = (today - timedelta(days=1)).isoformat()
                due_yesterday = now - progress.get("yesterday_checked_at", 0) >= 900
                days = ([yesterday] if due_yesterday else []) + pending[:limit]
                for day in dict.fromkeys(days):
                    if self._stop.is_set():
                        break
                    try:
                        previous, previous_freshness = self._read_day(date.fromisoformat(day), pair, now)
                        self._save_day(source, previous, previous_freshness, now)
                        if day == yesterday:
                            progress["yesterday_checked_at"] = now
                    except Exception:
                        # A capped or unavailable historical response leaves its
                        # row/checkpoint untouched and is retried on a later tick.
                        state["message"] = "当前数据已更新；部分历史记录等待回填"
                with self._db() as db:
                    self._put_meta(db, "progress:" + source, progress)
                    self._put_meta(db, "state", state)
            except Exception as error:
                state.update(status="missing_watchers" if isinstance(error, _MissingWatchers) else "offline",
                             message=str(error) if isinstance(error, ActivityError) else "ActivityWatch 暂时不可用，已保留本地归档")
                with self._db() as db:
                    self._put_meta(db, "state", state)
        return self.summary()

    def _range(self, days, end):
        if isinstance(days, bool) or not re.fullmatch(r"[0-9]{1,3}", str(days)) or not 1 <= int(days) <= 366:
            raise ActivityError("天数应在 1 到 366 之间")
        today = datetime.fromtimestamp(self.clock(), TZ).date()
        try:
            if end is not None and (not isinstance(end, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", end)):
                raise ValueError()
            end_day = date.fromisoformat(end) if end is not None else today
            start_day = end_day - timedelta(days=int(days) - 1)
            if end_day > today:
                raise ValueError()
        except (ValueError, OverflowError):
            raise ActivityError("结束日期应为不晚于今天的 YYYY-MM-DD 日期") from None
        return int(days), start_day, end_day, today

    @staticmethod
    def _empty(day):
        return {"date": day, "status": "not_archived", **{key: None for key in METRICS}, "apps": []}

    def summary(self, days=7, end=None):
        days, start, finish, today = self._range(days, end)
        now = self.clock()
        with self._db() as db:
            # sqlite3's connection context does not start a transaction for
            # SELECTs. Pin one WAL snapshot for totals, apps and metadata so a
            # collector commit cannot mix two archive versions in one response.
            db.execute("BEGIN")
            source = self._get_meta(db, "active_source", "")
            state = self._get_meta(db, "state", {})
            progress = self._get_meta(db, "progress:" + source, {})
            rows = db.execute("""SELECT * FROM activity_days WHERE source=? AND
                ((day>=? AND day<=?) OR day=?)""", (source, start.isoformat(), finish.isoformat(), today.isoformat())).fetchall()
            by_date = {row["day"]: {"date": row["day"], "status": row["status"],
                                    **{key: row[key] for key in METRICS}, "apps": []} for row in rows}
            for row in db.execute("""SELECT day,app,seconds FROM activity_apps WHERE source=? AND
                    ((day>=? AND day<=?) OR day=?) ORDER BY seconds DESC,app""",
                                  (source, start.isoformat(), finish.isoformat(), today.isoformat())):
                if row["day"] in by_date:
                    by_date[row["day"]]["apps"].append({"app": row["app"], "seconds": row["seconds"]})
            archive = db.execute("SELECT MIN(day),MAX(day),COUNT(*) FROM activity_days WHERE source=? AND status!='no_data'",
                                 (source,)).fetchone()
            pending = len(self._pending(db, source, progress.get("floor", (today - timedelta(days=self.history_days)).isoformat()), today))
        daily = [by_date.get((start + timedelta(days=index)).isoformat(), self._empty((start + timedelta(days=index)).isoformat()))
                 for index in range(days)]
        apps = defaultdict(float)
        for item in daily:
            for app in item["apps"]:
                apps[app["app"]] += app["seconds"]
        status = state.get("status", "loading") if self.enabled else "disabled"
        last_check = state.get("last_checked_at")
        freshness = [state.get("window_updated_at"), state.get("afk_updated_at")]
        stale = (status != "online" or state.get("retained_previous", False)
                 or last_check is None or now - last_check > max(STALE_SECONDS, self.poll_seconds * 3)
                 or any(value is None or now - value > max(STALE_SECONDS, self.poll_seconds * 3) for value in freshness))
        return {"ok": True, "timezone": "Asia/Shanghai", "generated_at": now,
                "source": {"available": status == "online", "status": status,
                           "message": state.get("message", "等待后台首次采集") if self.enabled else "电脑使用采集已关闭，已有归档保留",
                           "last_checked_at": last_check, "last_success_at": state.get("last_success_at"),
                           "window_updated_at": freshness[0], "afk_updated_at": freshness[1], "stale": stale},
                "archive": {"retention": "indefinite", "first_date": archive[0], "last_date": archive[1],
                            "recorded_days": archive[2], "backfill_pending_days": pending},
                "today": by_date.get(today.isoformat(), self._empty(today.isoformat())),
                "range": {"start": start.isoformat(), "end": finish.isoformat(), "days": days,
                          "active_seconds": round(sum(row["active_seconds"] or 0 for row in daily), 3),
                          "recorded_days": sum(row["status"] in ("recorded", "partial") for row in daily)},
                "daily": daily,
                "apps": [{"app": app, "seconds": round(seconds, 3)}
                         for app, seconds in sorted(apps.items(), key=lambda item: (-item[1], item[0]))]}

    def export(self, days=30, end=None):
        result = self.summary(days=days, end=end)
        return {"ok": True, "format": "flitfancy-activity-summary-v1", "timezone": result["timezone"],
                "exported_at": result["generated_at"], "retention": "indefinite",
                "measurement": "前台应用与非离开状态的交集；不是开机时间或坐在电脑前的时间",
                "range": result["range"], "daily": result["daily"], "apps": result["apps"]}
