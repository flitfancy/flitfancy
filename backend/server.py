"""flitfancy 控制台服务（仅用 Python 标准库）。

运行（在 backend 目录下）：
    python server.py
然后打开 http://localhost:8137/

职责：
- 提供前端静态站点（../docs：首页/项目/日志/控制台，docs 即 GitHub Pages 发布目录）
- 接收感知板 STREAM/WiFi 数据（POST /api/ingest，支持 CSV 行或 JSON）
- 保存传感器读数与记忆（SQLite: data/flitfancy.db）
- 给控制台和小流萤的大脑（AstrBot）提供查询 API
"""

import json
import os
import sqlite3
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.path.normpath(os.path.join(BASE, "..", "docs"))
DATA_DIR = os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA_DIR, "flitfancy.db")
HOST = "0.0.0.0"
PORT = 8137
CST = timezone(timedelta(hours=8))

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
}


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def db_init():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = db()
    con.execute(
        """CREATE TABLE IF NOT EXISTS sensors(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, channel TEXT, sensor TEXT, ok INTEGER,
            temp_c REAL, rh_pct REAL, pressure_pa REAL,
            als_raw REAL, uv_raw REAL,
            voc_index REAL, nox_index REAL, co2_ppm REAL,
            extra TEXT)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS notes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, author TEXT, content TEXT)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS commands(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, command TEXT, status TEXT)"""
    )
    con.commit()
    con.close()


def ingest_json(row):
    """把一行 JSON 传感器数据写入 sensors 表。"""
    con = db()
    con.execute(
        """INSERT INTO sensors(
            ts, channel, sensor, ok, temp_c, rh_pct, pressure_pa,
            als_raw, uv_raw, voc_index, nox_index, co2_ppm, extra)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            row.get("ts") or now_iso(),
            row.get("channel"),
            row.get("sensor"),
            1 if row.get("ok") in (None, 1, "1", True) else 0,
            row.get("temp_c"),
            row.get("rh_pct"),
            row.get("pressure_pa"),
            row.get("als_raw"),
            row.get("uv_raw"),
            row.get("voc_index"),
            row.get("nox_index"),
            row.get("co2_ppm"),
            json.dumps({k: v for k, v in row.items() if k not in (
                "ts", "channel", "sensor", "ok", "temp_c", "rh_pct", "pressure_pa",
                "als_raw", "uv_raw", "voc_index", "nox_index", "co2_ppm"
            )}, ensure_ascii=False),
        ),
    )
    con.commit()
    con.close()


def ingest_csv_line(line):
    """解析 STREAM/WiFi 导出的 CSV 行。表头需要包含 uptime_ms/channel/sensor。"""
    parts = line.rstrip("\r\n").split(",")
    if len(parts) < 6:
        return False
    idx = {}
    header = None
    for i, p in enumerate(parts):
        if p.strip() == "uptime_ms":
            header = [x.strip() for x in parts]
            idx = {name: i for i, name in enumerate(header)}
            break
    if header is None:
        return False

    def col(name, default=None):
        j = idx.get(name)
        if j is None or j >= len(parts):
            return default
        v = parts[j].strip()
        if v == "":
            return default
        try:
            return float(v)
        except ValueError:
            return default

    sensor = parts[idx.get("sensor", 0)].strip() if "sensor" in idx else ""
    channel = sensor.split()[0] if sensor and " " in sensor else sensor
    row = {
        "ts": parts[0] if parts and parts[0].strip() else now_iso(),
        "channel": channel or None,
        "sensor": sensor or None,
        "ok": parts[idx["ok"]].strip() if "ok" in idx else "1",
        "temp_c": col("temp_c"),
        "rh_pct": col("rh_pct"),
        "pressure_pa": col("pressure_pa"),
        "als_raw": col("als_raw"),
        "uv_raw": col("uv_raw"),
        "voc_index": col("voc_index"),
        "nox_index": col("nox_index"),
        "co2_ppm": col("co2_ppm"),
    }
    if row["ok"] == "1" and sensor:
        ingest_json(row)
        return True
    return False


class Handler(BaseHTTPRequestHandler):
    server_version = "flitfancy/0.1"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (now_iso(), fmt % args))

    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self, limit=1_000_000):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            return None
        return self.rfile.read(length)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self._api_get(path)
            return
        self._serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/ingest":
            self._api_ingest()
        elif parsed.path == "/api/command":
            self._api_command()
        elif parsed.path == "/api/notes":
            self._api_note_create()
        else:
            self._send(404, {"error": "not found"})

    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        target = os.path.normpath(os.path.join(SITE_ROOT, rel))
        if not target.startswith(SITE_ROOT) or not os.path.isfile(target):
            self._send(404, {"error": "not found"}, "application/json; charset=utf-8")
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    def _api_get(self, path):
        if path == "/api/status":
            con = db()
            n_sensors = con.execute("SELECT COUNT(*) FROM sensors").fetchone()[0]
            n_notes = con.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
            con.close()
            self._send(200, {
                "name": "flitfancy",
                "time": now_iso(),
                "sensor_rows": n_sensors,
                "notes": n_notes,
                "msg": "flitfancy 在线 · 已记录 %d 条感知数据 · %d 条记忆" % (n_sensors, n_notes),
            })
        elif path == "/api/sensors/latest":
            con = db()
            rows = con.execute(
                """SELECT s.* FROM sensors s
                   JOIN (SELECT channel, MAX(id) AS mid FROM sensors
                         WHERE channel IS NOT NULL GROUP BY channel) m
                     ON s.id = m.mid
                   ORDER BY s.channel"""
            ).fetchall()
            con.close()
            self._send(200, {"rows": [dict(r) for r in rows]})
        elif path == "/api/sensors/history":
            con = db()
            rows = con.execute(
                "SELECT * FROM sensors ORDER BY id DESC LIMIT 300"
            ).fetchall()
            con.close()
            self._send(200, {"rows": [dict(r) for r in rows]})
        elif path == "/api/notes":
            con = db()
            rows = con.execute(
                "SELECT * FROM notes ORDER BY id DESC LIMIT 50"
            ).fetchall()
            con.close()
            self._send(200, {"rows": [dict(r) for r in rows]})
        else:
            self._send(404, {"error": "unknown api"})

    def _api_ingest(self):
        body = self._read_body()
        if not body:
            self._send(400, {"error": "empty body"})
            return
        text = body.decode("utf-8", errors="replace").strip()
        count = 0
        if text.startswith("{"):
            try:
                data = json.loads(text)
            except ValueError:
                self._send(400, {"error": "bad json"})
                return
            rows = data if isinstance(data, list) else [data]
            for row in rows:
                ingest_json(row)
                count += 1
        else:
            for line in text.splitlines():
                if ingest_csv_line(line):
                    count += 1
        self._send(200, {"ok": True, "ingested": count})

    def _api_command(self):
        body = self._read_body()
        command = ""
        if body:
            try:
                command = json.loads(body.decode("utf-8")).get("command", "")
            except ValueError:
                command = ""
        command = command.strip().upper()
        if not command:
            self._send(400, {"error": "command required"})
            return
        con = db()
        con.execute(
            "INSERT INTO commands(ts, command, status) VALUES(?,?,?)",
            (now_iso(), command, "queued"),
        )
        con.commit()
        con.close()
        self._send(200, {
            "ok": True,
            "command": command,
            "note": "已记入命令队列（串口/网络转发将在下一步接入）",
        })

    def _api_note_create(self):
        body = self._read_body()
        if not body:
            self._send(400, {"error": "empty body"})
            return
        try:
            data = json.loads(body.decode("utf-8"))
        except ValueError:
            self._send(400, {"error": "bad json"})
            return
        content = (data.get("content") or "").strip()
        if not content:
            self._send(400, {"error": "content required"})
            return
        author = (data.get("author") or "console").strip()[:40]
        con = db()
        con.execute(
            "INSERT INTO notes(ts, author, content) VALUES(?,?,?)",
            (now_iso(), author, content[:2000]),
        )
        con.commit()
        con.close()
        self._send(200, {"ok": True})


def main():
    db_init()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print("flitfancy 控制台服务已启动: http://localhost:%d/" % PORT)
    print("前端目录: %s" % SITE_ROOT)
    print("数据文件: %s" % DB_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
