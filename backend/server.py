"""flitfancy 控制台服务（仅用 Python 标准库）。

运行（在 backend 目录下）：
    python server.py
然后打开 http://localhost:2671/

职责：
- 提供前端静态站点（../docs：首页/项目/日志/控制台，docs 即 GitHub Pages 发布目录）
- 接收感知板 STREAM/WiFi 数据（POST /api/ingest，支持 CSV 行或 JSON）
- 保存传感器读数与记忆（SQLite: data/flitfancy.db）
- 给控制台和小流萤的大脑（AstrBot）提供查询 API
"""

import getpass
import hashlib
import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.path.normpath(os.path.join(BASE, "..", "docs"))
DATA_DIR = os.path.join(BASE, "data")
DB_PATH = os.path.join(DATA_DIR, "flitfancy.db")
HOST = "0.0.0.0"
PORT = 2671
CST = timezone(timedelta(hours=8))

AI_CONFIG_PATH = os.path.join(BASE, "ai_local.json")

# 直连 AI 服务，不走系统/环境代理（本机 git 代理是给 GitHub 用的）
AI_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

ADMIN_TOKEN_TTL = 12 * 3600          # 登录令牌有效期 12 小时
LOGIN_MAX_FAILS = 5                  # 连续输错次数上限
LOGIN_LOCK_SECONDS = 10 * 60         # 超限后锁定 10 分钟

MODEL_BASE_URLS = {
    "deepseek-chat": "https://api.deepseek.com",
    "deepseek-reasoner": "https://api.deepseek.com",
    "qwen-turbo": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-plus": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-max": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-vl-plus": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "qwen-vl-max": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "kimi-latest": "https://api.moonshot.cn/v1",
    "moonshot-v1-8k": "https://api.moonshot.cn/v1",
    "moonshot-v1-32k": "https://api.moonshot.cn/v1",
    "moonshot-v1-128k": "https://api.moonshot.cn/v1",
    "glm-4-flash": "https://open.bigmodel.cn/api/paas/v4",
    "glm-4": "https://open.bigmodel.cn/api/paas/v4",
    "mimo-v2.5": "https://api.xiaomimimo.com/v1",
}

_admin_tokens = {}   # token -> 过期时间戳
_admin_fails = {}    # ip -> [已失败次数, 锁定截止时间戳]
_admin_lock = threading.Lock()

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


def _read_local_cfg():
    """读取本地 ai_local.json（密钥/管理配置，不推送）。"""
    if os.path.isfile(AI_CONFIG_PATH):
        try:
            with open(AI_CONFIG_PATH, "r", encoding="utf-8") as f:
                return json.load(f) or {}
        except (OSError, ValueError):
            return {}
    return {}


def ai_config():
    """读取 AI 服务配置：环境变量优先，回退到本地 ai_local.json。"""
    cfg = _read_local_cfg()
    return {
        "base_url": (
            os.environ.get("FLITFANCY_AI_BASE_URL")
            or cfg.get("base_url")
            or "https://api.deepseek.com"
        ).rstrip("/"),
        "api_key": os.environ.get("FLITFANCY_AI_KEY") or cfg.get("api_key") or "",
        "model": os.environ.get("FLITFANCY_AI_MODEL") or cfg.get("model") or "deepseek-chat",
        "system": (
            os.environ.get("FLITFANCY_AI_SYSTEM") or cfg.get("system") or ""
        ).strip(),
    }


def ai_config_save(updates):
    """把更新写回 ai_local.json（保留已有字段）。"""
    cfg = _read_local_cfg()
    cfg.update(updates)
    with open(AI_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    return cfg


def base_url_for_model(model, fallback):
    """按模型名推断接口地址；认不出的保留现有地址。"""
    if model in MODEL_BASE_URLS:
        return MODEL_BASE_URLS[model]
    for prefix, url in (
        ("deepseek", "https://api.deepseek.com"),
        ("qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        ("kimi", "https://api.moonshot.cn/v1"),
        ("moonshot", "https://api.moonshot.cn/v1"),
        ("glm", "https://open.bigmodel.cn/api/paas/v4"),
        ("mimo", "https://api.xiaomimimo.com/v1"),
    ):
        if model.startswith(prefix):
            return url
    return fallback


def sync_public_chat_enabled(enabled):
    """把开关同步到公网 Worker（api.flitfancy.com）。返回 (是否成功, 提示)。"""
    cfg = _read_local_cfg()
    url = cfg.get("worker_admin_url") or ""
    token = cfg.get("worker_admin_token") or ""
    if not url or not token:
        return False, "未配置公网同步地址（ai_local.json 的 worker_admin_url/token）"
    try:
        req = urllib.request.Request(
            url.rstrip("/") + "/admin/toggle",
            data=json.dumps({"chat_enabled": bool(enabled)}).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
            },
        )
        with AI_OPENER.open(req, timeout=8) as resp:
            if resp.status == 200:
                return True, ""
            return False, "公网返回状态 %d" % resp.status
    except Exception as e:
        msg = str(e)
        if "getaddrinfo failed" in msg:
            return False, "公网地址无法解析（本地 DNS 未刷新，可试 ipconfig /flushdns）"
        return False, "公网同步失败：%s" % msg


def admin_verify_password(username, password):
    """按用户名查账号并校验密码（密码只存哈希）。"""
    cfg = _read_local_cfg()
    for acc in cfg.get("admin_accounts") or []:
        if (acc.get("username") or "") == (username or ""):
            salt = acc.get("salt") or ""
            expected = acc.get("password_hash") or ""
            if not salt or not expected:
                return False
            actual = hashlib.sha256((salt + (password or "")).encode("utf-8")).hexdigest()
            return actual == expected
    return False


def admin_login(ip, username, password):
    """校验账号密码：成功发令牌；失败计数，超限锁定。返回 (ok, token或错误信息)。"""
    now = time.time()
    with _admin_lock:
        rec = _admin_fails.get(ip) or [0, 0]
        if rec[1] > now:
            mins = int((rec[1] - now) // 60) + 1
            return False, "尝试次数过多，请 %d 分钟后再试" % mins
        if admin_verify_password(username, password):
            _admin_fails[ip] = [0, 0]
            token = secrets.token_hex(24)
            _admin_tokens[token] = now + ADMIN_TOKEN_TTL
            return True, token
        rec[0] += 1
        if rec[0] >= LOGIN_MAX_FAILS:
            _admin_fails[ip] = [0, LOGIN_LOCK_SECONDS + now]
            return False, "密码错误次数过多，已锁定 10 分钟"
        _admin_fails[ip] = rec
        return False, "用户名或密码错误（还可尝试 %d 次）" % (LOGIN_MAX_FAILS - rec[0])


def admin_token_valid(token):
    now = time.time()
    with _admin_lock:
        exp = _admin_tokens.get(token)
        if not exp:
            return False
        if exp < now:
            _admin_tokens.pop(token, None)
            return False
        return True


def admin_logout(token):
    with _admin_lock:
        _admin_tokens.pop(token, None)


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

    def _json_body(self):
        """读取并解析 JSON 请求体；失败时已发送 400 并返回 None。"""
        body = self._read_body()
        if not body:
            self._send(400, {"error": "empty body"})
            return None
        try:
            data = json.loads(body.decode("utf-8"))
        except ValueError:
            self._send(400, {"error": "bad json"})
            return None
        if not isinstance(data, dict):
            self._send(400, {"error": "bad json"})
            return None
        return data

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
        elif parsed.path == "/api/chat":
            self._api_chat()
        elif parsed.path == "/api/admin/login":
            self._api_admin_login()
        elif parsed.path == "/api/admin/logout":
            self._api_admin_logout()
        elif parsed.path == "/api/admin/config":
            self._api_admin_config_set()
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
                "chat_enabled": bool(_read_local_cfg().get("chat_enabled", True)),
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
        elif path == "/api/admin/config":
            self._api_admin_config_get()
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
        data = self._json_body()
        command = (data.get("command") or "").strip().upper() if data else ""
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
        data = self._json_body()
        if data is None:
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

    def _api_chat(self):
        data = self._json_body()
        if data is None:
            return
        messages = data.get("messages") or []
        messages = [
            m for m in messages
            if isinstance(m, dict)
            and m.get("role") in ("user", "assistant")
            and isinstance(m.get("content"), str)
            and m["content"].strip()
        ][-20:]
        if not messages:
            self._send(400, {"error": "messages required"})
            return
        if not _read_local_cfg().get("chat_enabled", True):
            self._send(403, {"ok": False, "error": "AI 对话已由管理员关闭"})
            return
        cfg = ai_config()
        if not cfg["api_key"]:
            self._send(503, {
                "ok": False,
                "error": "AI 尚未配置：请在 backend/ai_local.json 填入 api_key（或设置环境变量 FLITFANCY_AI_KEY）",
            })
            return
        messages_payload = list(messages)
        if cfg["system"]:
            messages_payload.insert(0, {"role": "system", "content": cfg["system"]})
        payload = {
            "model": cfg["model"],
            "messages": messages_payload,
            "stream": False,
        }
        url = cfg["base_url"] + "/chat/completions"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + cfg["api_key"],
            },
        )
        try:
            with AI_OPENER.open(req, timeout=90) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:300]
            self._send(502, {
                "ok": False,
                "error": "AI 服务返回错误（检查 api_key / model / 余额）",
                "detail": detail,
            })
            return
        except urllib.error.URLError as e:
            self._send(502, {
                "ok": False,
                "error": "无法连接 AI 服务（检查 base_url 与网络）",
                "detail": str(e.reason),
            })
            return
        try:
            reply = result["choices"][0]["message"]["content"].strip()
        except (KeyError, IndexError, TypeError):
            self._send(502, {
                "ok": False,
                "error": "AI 服务返回格式异常",
                "detail": str(result)[:300],
            })
            return
        self._send(200, {"ok": True, "reply": reply})

    def _admin_token_from_request(self):
        auth = self.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return ""

    def _require_admin(self):
        token = self._admin_token_from_request()
        if not token or not admin_token_valid(token):
            self._send(401, {"ok": False, "error": "未登录或登录已过期"})
            return None
        return token

    def _api_admin_login(self):
        data = self._json_body()
        if data is None:
            return
        username = (data.get("username") or "").strip()
        password = data.get("password") or ""
        if not username or not password:
            self._send(400, {"ok": False, "error": "请输入用户名和密码"})
            return
        ok, payload = admin_login(self.client_address[0], username, password)
        if ok:
            self._send(200, {"ok": True, "token": payload})
        else:
            self._send(403, {"ok": False, "error": payload})

    def _api_admin_logout(self):
        token = self._admin_token_from_request()
        if token:
            admin_logout(token)
        self._send(200, {"ok": True})

    def _api_admin_config_get(self):
        if self._require_admin() is None:
            return
        cfg = _read_local_cfg()
        self._send(200, {
            "ok": True,
            "model": cfg.get("model") or "",
            "chat_enabled": bool(cfg.get("chat_enabled", True)),
            "quick_links": cfg.get("quick_links") or [],
        })

    def _api_admin_config_set(self):
        if self._require_admin() is None:
            return
        data = self._json_body()
        if data is None:
            return
        updates = {}
        if "model" in data:
            model = (data.get("model") or "").strip()
            if model:
                updates["model"] = model
                updates["base_url"] = base_url_for_model(
                    model, _read_local_cfg().get("base_url") or "https://api.deepseek.com"
                )
        if "chat_enabled" in data:
            updates["chat_enabled"] = bool(data["chat_enabled"])
        if "quick_links" in data and isinstance(data["quick_links"], list):
            links = []
            for item in data["quick_links"][:50]:
                if isinstance(item, dict) and item.get("name") and item.get("url"):
                    links.append({
                        "name": str(item["name"])[:60],
                        "url": str(item["url"])[:300],
                    })
            updates["quick_links"] = links
        ai_config_save(updates)
        cfg = _read_local_cfg()
        sync_ok = True
        sync_note = ""
        if "chat_enabled" in updates:
            sync_ok, sync_note = sync_public_chat_enabled(updates["chat_enabled"])
        self._send(200, {
            "ok": True,
            "model": cfg.get("model") or "",
            "chat_enabled": bool(cfg.get("chat_enabled", True)),
            "quick_links": cfg.get("quick_links") or [],
            "public_sync": sync_ok,
            "public_sync_note": sync_note,
        })


def main():
    if "--set-password" in sys.argv:
        i = sys.argv.index("--set-password")
        username = None
        new_pwd = None
        if i + 1 < len(sys.argv) and not sys.argv[i + 1].startswith("-"):
            username = sys.argv[i + 1]
        if i + 2 < len(sys.argv) and not sys.argv[i + 2].startswith("-"):
            new_pwd = sys.argv[i + 2]
        if not username:
            print("用法：python server.py --set-password <用户名> [新密码]")
            sys.exit(1)
        if not new_pwd:
            new_pwd = getpass.getpass("请输入 %s 的新密码: " % username).strip()
        if len(new_pwd) < 6:
            print("密码至少 6 位，未修改")
            sys.exit(1)
        salt = secrets.token_hex(16)
        pwd_hash = hashlib.sha256((salt + new_pwd).encode("utf-8")).hexdigest()
        accounts = _read_local_cfg().get("admin_accounts") or []
        found = False
        for acc in accounts:
            if (acc.get("username") or "") == username:
                acc["salt"] = salt
                acc["password_hash"] = pwd_hash
                found = True
                break
        if not found:
            accounts.append({"username": username, "salt": salt, "password_hash": pwd_hash})
        ai_config_save({"admin_accounts": accounts})
        print("账号 %s 的密码已更新（本地只存哈希，不存明文）" % username)
        return
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
