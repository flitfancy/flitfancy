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
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def _env_int(name, default, minimum=0):
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


BASE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.path.normpath(os.path.join(BASE, "..", "docs"))
DB_PATH = os.environ.get("FLITFANCY_DB_PATH") or os.path.join(BASE, "data", "flitfancy.db")
DATA_DIR = os.path.dirname(os.path.abspath(DB_PATH))
SENSOR_RAW_DATA_DIR = os.path.normpath(os.path.join(BASE, "..", "data", "sensors"))
# 默认只监听回环：LAN 侧入口只有监听器（7777，供感知板推送），
# 后端 2671 供 cloudflared 隧道与本地浏览器使用，无需暴露局域网。
HOST = os.environ.get("FLITFANCY_HOST") or "127.0.0.1"
PORT = int(os.environ.get("FLITFANCY_PORT") or "2671")
CST = timezone(timedelta(hours=8))
SENSOR_RETENTION_DAYS = _env_int("FLITFANCY_SENSOR_RETENTION_DAYS", 14, 1)
SENSOR_PRUNE_INTERVAL_SECONDS = _env_int(
    "FLITFANCY_SENSOR_PRUNE_INTERVAL_SECONDS", 3600, 0,
)

AI_CONFIG_PATH = os.environ.get("FLITFANCY_AI_CONFIG_PATH") or os.path.join(BASE, "ai_local.json")

# 直连 AI 服务，不走系统/环境代理（本机 git 代理是给 GitHub 用的）
AI_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

ADMIN_TOKEN_TTL = 12 * 3600          # 登录令牌有效期 12 小时
LOGIN_MAX_FAILS = 5                  # 连续输错次数上限
LOGIN_LOCK_SECONDS = 10 * 60         # 超限后锁定 10 分钟
ADMIN_FAILS_MAX_ENTRIES = 4096       # 失败记录条数封顶（防海量 IP 刷登录撑大内存）
REQUEST_READ_TIMEOUT = 10            # slowloris 防护：请求头/体读取阶段最长等待秒数
PASSWORD_SCHEME = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 600_000
MIN_NEW_PASSWORD_LENGTH = 14
MIN_WORKER_ADMIN_TOKEN_LENGTH = 32
_DUMMY_PASSWORD_SALT = bytes.fromhex("7d0fe8b9c04649c4ae85eb0f826fa5a1")
_DUMMY_PASSWORD_HASH = "0" * 64

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
_config_lock = threading.RLock()
_sensor_sync_lock = threading.Lock()
_sensor_sync_pending = {}
_sensor_sync_running = False
_sensor_prune_lock = threading.Lock()
_sensor_last_prune = 0.0

SENSOR_CSV_FIELDS = (
    "uptime_ms", "cycle", "channel_index", "sensor", "ok", "temp_c",
    "rh_pct", "als_raw", "uv_raw", "f1_415", "f2_445", "f3_480",
    "f4_515", "f5_555", "f6_590", "f7_630", "f8_680", "clear_raw",
    "nir_raw", "voc_index", "nox_index", "sraw_voc", "sraw_nox",
    "co2_ppm", "pressure_pa", "as7341_atime", "as7341_astep",
    "as7341_gainx",
    "sample_age_ms", "sample_seq", "error_streak", "firmware_version",
    "schema_version", "scheduler", "flicker_hz", "rssi_dbm",
)
SENSOR_TEXT_FIELDS = {"firmware_version", "scheduler"}
SENSOR_VALUE_FIELDS = (
    "temp_c", "rh_pct", "pressure_pa", "als_raw", "uv_raw", "voc_index",
    "nox_index", "co2_ppm",
)

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def compute_history_buckets(hours, channel=None):
    """按 10 分钟桶聚合传感器历史（均值/最小/最大）。
    channel 为空时聚合全部通道（用于云端同步）。"""
    if hours < 1 or hours > 72:
        hours = 24
    cutoff = (
        datetime.now(CST) - timedelta(hours=hours)
    ).isoformat(timespec="seconds")
    value_columns = SENSOR_VALUE_FIELDS   # 与传感器写入侧同一份列清单
    agg_parts = []
    for col in value_columns:
        agg_parts.append(
            "AVG(%s) AS %s, MIN(%s) AS %s_min, MAX(%s) AS %s_max"
            % (col, col, col, col, col, col)
        )
    # 以下字段存在 extra JSON 里，需用 json_extract 聚合：
    # 光谱八波段（AS7341 真正的价值所在）与 SGP41 原始信号都完整保留，
    # 历史桶与云端同步不得丢弃——原始数据是后续所有下游分析的唯一地基。
    for col in (
        "clear_raw", "nir_raw",
        "f1_415", "f2_445", "f3_480", "f4_515",
        "f5_555", "f6_590", "f7_630", "f8_680",
        "sraw_voc", "sraw_nox",
    ):
        expr = "CAST(json_extract(extra, '$." + col + "') AS REAL)"
        agg_parts.append(
            "AVG(%s) AS %s, MIN(%s) AS %s_min, MAX(%s) AS %s_max"
            % (expr, col, expr, col, expr, col)
        )
    select = "substr(ts, 1, 15) || '0:00+08:00' AS bucket, COUNT(*) AS n, " + ", ".join(agg_parts)
    where = "ts >= ?"
    args = [cutoff]
    group = "bucket"
    if channel:
        where += " AND channel = ?"
        args.append(channel)
    else:
        select = "channel, " + select
        group = "channel, bucket"
    con = db()
    rows = con.execute(
        "SELECT " + select + " FROM sensors WHERE " + where
        + " GROUP BY " + group + " ORDER BY " + group,
        args,
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


def sync_public_history(hours=26):
    """把最近 N 小时的分桶历史幂等同步到 Worker（历史上云）。
    返回 (是否成功, 提示)。失败不影响本地。"""
    rows = compute_history_buckets(hours)
    if not rows:
        return True, "暂无数据"
    ok, note = worker_post(
        "/admin/sensors-history", {"rows": rows}, 15, "公网历史接口"
    )
    return ok, note


def _history_sync_loop():
    """每 5 分钟把分桶历史同步到 Worker；断网只记日志不重试风暴。"""
    time.sleep(15)   # 启动后先同步一次
    while True:
        ok, note = sync_public_history()
        if not ok:
            print("[%s] 公网历史同步暂不可用: %s" % (now_iso(), note))
        sync_pending_anchors()
        sync_pending_memories()
        time.sleep(300)


MEMORIES_SELECT = (
    "uid, memory_time AS time, time_precision AS precision, "
    "perspective, content, synced"
)

_service_cache_lock = threading.Lock()
_service_cache = {"t": 0.0, "listener": False, "tunnel": False}

_status_counts_cache = {"t": 0.0, "sensors": 0, "notes": 0}
_status_counts_lock = threading.Lock()


def _status_counts():
    """传感器/笔记计数，缓存 10 秒——/api/status 每几秒被轮询，
    每次 COUNT(*) 全表扫没有意义。"""
    now = time.monotonic()
    with _status_counts_lock:
        if now - _status_counts_cache["t"] < 10:
            return _status_counts_cache["sensors"], _status_counts_cache["notes"]
    con = db()
    n_sensors = con.execute("SELECT COUNT(*) FROM sensors").fetchone()[0]
    n_notes = con.execute("SELECT COUNT(*) FROM notes").fetchone()[0]
    con.close()
    with _status_counts_lock:
        _status_counts_cache.update({"t": now, "sensors": n_sensors, "notes": n_notes})
    return n_sensors, n_notes


def service_status():
    """轻量心跳：感知板监听器（新鲜快照）与隧道进程；结果缓存 3 秒。"""
    now = time.monotonic()
    with _service_cache_lock:
        if now - _service_cache["t"] < 3:
            return {"listener": _service_cache["listener"], "tunnel": _service_cache["tunnel"]}
    # 注意：绝不能主动连 7777 探测——监听器把任何新 TCP 连接都当作
    # “新板接入”并切换会话，探测会反复打断真实板端的数据流。
    # 只以“最近 30 秒内有新鲜快照”作为监听器健康的依据。
    listener = False
    con = db()
    last_ts = con.execute(
        "SELECT MAX(ts) FROM sensors WHERE channel IS NOT NULL"
    ).fetchone()[0]
    con.close()
    if last_ts:
        try:
            parsed = datetime.fromisoformat(str(last_ts).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=CST)
            age = (datetime.now(CST) - parsed.astimezone(CST)).total_seconds()
            listener = 0 <= age <= 30
        except ValueError:
            listener = False
    tunnel = False
    try:
        out = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq cloudflared.exe", "/NH"],
            capture_output=True, text=True, timeout=5,
        ).stdout
        tunnel = "cloudflared" in out
    except Exception:
        pass
    with _service_cache_lock:
        _service_cache.update({"t": now, "listener": listener, "tunnel": tunnel})
    return {"listener": listener, "tunnel": tunnel}


def db():
    con = sqlite3.connect(DB_PATH, timeout=5)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=5000")
    return con


def db_init():
    os.makedirs(DATA_DIR, exist_ok=True)
    con = db()
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA wal_autocheckpoint=1000")
    con.execute(
        """CREATE TABLE IF NOT EXISTS sensors(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, board TEXT, uptime_ms INTEGER, cycle INTEGER,
            channel TEXT, sensor TEXT, ok INTEGER,
            temp_c REAL, rh_pct REAL, pressure_pa REAL,
            als_raw REAL, uv_raw REAL,
            voc_index REAL, nox_index REAL, co2_ppm REAL,
            extra TEXT)"""
    )
    sensor_columns = {
        row[1] for row in con.execute("PRAGMA table_info(sensors)").fetchall()
    }
    if "board" not in sensor_columns:
        con.execute("ALTER TABLE sensors ADD COLUMN board TEXT")
        con.execute(
            "UPDATE sensors SET board = 'firefly-r1-1' WHERE board IS NULL"
        )
    if "uptime_ms" not in sensor_columns:
        con.execute("ALTER TABLE sensors ADD COLUMN uptime_ms INTEGER")
    if "cycle" not in sensor_columns:
        con.execute("ALTER TABLE sensors ADD COLUMN cycle INTEGER")
    con.execute(
        """CREATE TABLE IF NOT EXISTS notes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, author TEXT, content TEXT)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS memories(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL,
            memory_date TEXT NOT NULL,
            perspective TEXT NOT NULL,
            source TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0,
            time_precision TEXT NOT NULL DEFAULT 'second')"""
    )
    memory_columns = {
        row[1] for row in con.execute("PRAGMA table_info(memories)").fetchall()
    }
    if "memory_time" not in memory_columns:
        con.execute("ALTER TABLE memories ADD COLUMN memory_time TEXT")
        con.execute(
            """UPDATE memories
               SET memory_time = memory_date || 'T00:00:00+08:00'
               WHERE memory_time IS NULL OR memory_time = ''"""
        )
    if "time_precision" not in memory_columns:
        con.execute(
            "ALTER TABLE memories ADD COLUMN time_precision TEXT NOT NULL DEFAULT 'second'"
        )
        # 迁移前的旧记录只有日期；不能把补出的午夜误当成真实秒级时间。
        con.execute("UPDATE memories SET time_precision = 'date'")
    # 一次性迁移：仅当还有待合并的旧标题时才全表更新（跑过一次后恒跳过）
    needs_title_merge = con.execute(
        "SELECT EXISTS(SELECT 1 FROM memories "
        "WHERE title IS NOT NULL AND title != '' LIMIT 1)"
    ).fetchone()[0]
    if needs_title_merge:
        con.execute(
            """UPDATE memories
               SET content = CASE
                     WHEN trim(title) NOT IN ('', '.')
                     THEN trim(title) || CASE WHEN trim(content) != '' THEN '\n' || content ELSE '' END
                     ELSE content
                   END,
                   title = ''
               WHERE title IS NOT NULL AND title != ''"""
        )
    con.execute(
        """CREATE TABLE IF NOT EXISTS anchors(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uid TEXT UNIQUE NOT NULL,
            created_at TEXT NOT NULL,
            anchor_time TEXT NOT NULL,
            time_precision TEXT NOT NULL DEFAULT 'second',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            synced INTEGER NOT NULL DEFAULT 0)"""
    )
    con.execute(
        """CREATE TABLE IF NOT EXISTS commands(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT, command TEXT, status TEXT)"""
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_sensors_board_channel_id "
        "ON sensors(board, channel, id DESC)"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_sensors_ts ON sensors(ts)"
    )
    con.execute(
        "CREATE INDEX IF NOT EXISTS idx_sensors_channel_ts ON sensors(channel, ts)"
    )
    con.commit()
    con.close()
    maybe_prune_sensor_history(force=True)


def prune_sensor_history():
    """只清理 SQLite 查询副本；原始 CSV 归档永远不由后端删除。"""
    cutoff = (
        datetime.now(CST) - timedelta(days=SENSOR_RETENTION_DAYS)
    ).isoformat(timespec="milliseconds")
    con = db()
    try:
        cursor = con.execute("DELETE FROM sensors WHERE ts < ?", (cutoff,))
        con.commit()
        return max(0, cursor.rowcount)
    finally:
        con.close()


def maybe_prune_sensor_history(force=False):
    global _sensor_last_prune
    now = time.monotonic()
    if not force and now - _sensor_last_prune < SENSOR_PRUNE_INTERVAL_SECONDS:
        return 0
    with _sensor_prune_lock:
        now = time.monotonic()
        if not force and now - _sensor_last_prune < SENSOR_PRUNE_INTERVAL_SECONDS:
            return 0
        deleted = prune_sensor_history()
        _sensor_last_prune = now
        return deleted


_protocol_name_cache = {"t": 0.0, "name": ""}


def protocol_name():
    r"""读取安装脚本注册的随机协议名（HKCU\Software\FlitFancy\ProtocolName）。
    60 秒缓存（monotonic + dict，与 service_status 风格一致）；仅接受
    字母数字下划线连字符，非法/未安装时回退 flitfancy。"""
    now = time.monotonic()
    if _protocol_name_cache["t"] and now - _protocol_name_cache["t"] < 60:
        return _protocol_name_cache["name"] or "flitfancy"
    name = ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\FlitFancy") as key:
            value, _ = winreg.QueryValueEx(key, "ProtocolName")
            if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value.strip()):
                name = value.strip()
    except Exception:
        name = ""
    _protocol_name_cache["t"] = now
    _protocol_name_cache["name"] = name
    return name or "flitfancy"


_local_cfg_cache = {"path": "", "mtime": 0.0, "data": {}}


def _read_local_cfg():
    """读取本地 ai_local.json（密钥/管理配置，不推送）。
    mtime 缓存：文件没变就不再读盘（聊天/心跳/同步的高频调用点）。"""
    if not os.path.isfile(AI_CONFIG_PATH):
        return {}
    try:
        mtime = os.path.getmtime(AI_CONFIG_PATH)
        if (_local_cfg_cache["path"] == AI_CONFIG_PATH
                and _local_cfg_cache["mtime"] == mtime):
            return _local_cfg_cache["data"]
        with open(AI_CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
        _local_cfg_cache.update({"path": AI_CONFIG_PATH, "mtime": mtime, "data": data})
        return data
    except (OSError, ValueError):
        return {}


def cfg_bool(value, default=True):
    """安全解析配置布尔值：字符串 "false"/"0" 不得被 bool() 误判为 True。"""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    return str(value).strip().lower() not in ("false", "0", "no", "off", "")


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
    with _config_lock:
        cfg = _read_local_cfg()
        cfg.update(updates)
        tmp_path = AI_CONFIG_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, AI_CONFIG_PATH)
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


WORKER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


def worker_post(endpoint, payload, timeout=8, error_label="公网接口"):
    """向 Worker 发 POST 并返回 (是否成功, 提示)。统一 UA/超时/错误处理。"""
    cfg = _read_local_cfg()
    url = cfg.get("worker_admin_url") or ""
    token = cfg.get("worker_admin_token") or ""
    if not url or not token:
        return False, "未配置公网同步地址（ai_local.json 的 worker_admin_url/token）"
    if len(token) < MIN_WORKER_ADMIN_TOKEN_LENGTH:
        return False, "公网管理令牌长度不足（至少 32 个字符）"
    try:
        req = urllib.request.Request(
            url.rstrip("/") + endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
                "User-Agent": WORKER_UA,
            },
        )
        with AI_OPENER.open(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if resp.status == 200 and result.get("ok"):
                return True, ""
            return False, "公网返回状态 %d" % resp.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:160]
        return False, "%s返回 %d：%s" % (error_label, e.code, detail)
    except Exception as e:
        return False, "公网同步失败：%s" % e


def normalize_reflections(values):
    """清理随笔：一句话、去空去重；源头截 120 字（超长不应进入页尾标题）。
    与 cloudflare/worker.js 的 normalizeReflections 是跨语言双胞胎：
    改动规则时必须两边同步改（Worker 侧兜底公共读路径）。"""
    if not isinstance(values, list):
        return []
    rows = []
    seen = set()
    for value in values:
        if not isinstance(value, str):
            continue
        text = value.strip()[:120]
        if not text or text in seen:
            continue
        seen.add(text)
        rows.append(text)
        if len(rows) >= 100:
            break
    return rows


def sync_public_config(updates):
    """把公开配置同步到 Worker（api.flitfancy.com）。返回 (是否成功, 提示)。"""
    return worker_post("/admin/toggle", updates, 8, "公网配置接口")

def sync_public_memory(memory):
    """把一条本地日记幂等同步到 Worker。返回 (是否成功, 提示)。"""
    payload = {
        "uid": memory["uid"],
        "created_at": memory["created_at"],
        "time": memory["memory_time"],
        "precision": memory["time_precision"],
        "perspective": memory["perspective"],
        "source": memory["source"],
        "content": memory["content"],
    }
    return worker_post("/admin/memories", payload, 8, "公网日记接口")


def sync_public_anchor(anchor):
    """把一条本地锚点幂等同步到 Worker。返回 (是否成功, 提示)。"""
    payload = {
        "uid": anchor["uid"],
        "created_at": anchor["created_at"],
        "time": anchor["anchor_time"],
        "precision": anchor["time_precision"],
        "title": anchor["title"],
        "content": anchor["content"],
    }
    return worker_post("/admin/anchors", payload, 8, "公网锚点接口")


def _sync_pending_rows(table, pusher, limit):
    """重试补传 synced=0 的滞留记录（锚点/日记共用）：
    逐条推送，失败即停（不重试风暴），成功后落 synced=1。"""
    con = db()
    rows = con.execute(
        "SELECT * FROM %s WHERE synced = 0 ORDER BY id LIMIT ?" % table,
        (limit,),
    ).fetchall()
    con.close()
    synced = 0
    note = ""
    for row in rows:
        ok, note = pusher(dict(row))
        if not ok:
            break
        con = db()
        con.execute("UPDATE %s SET synced = 1 WHERE uid = ?" % table, (row["uid"],))
        con.commit()
        con.close()
        synced += 1
    return synced, note


def sync_pending_anchors(limit=20):
    """重试未同步的本地锚点。"""
    return _sync_pending_rows("anchors", sync_public_anchor, limit)


def sync_pending_memories(limit=20):
    """重试未同步的本地日记，避免临时断网造成记录丢失。"""
    return _sync_pending_rows("memories", sync_public_memory, limit)


def sync_public_sensors(rows):
    """把一批最新传感器快照同步到 Worker。网络失败不影响本地采集。"""
    if not rows:
        return False
    ok, _ = worker_post("/admin/sensors", {"rows": rows}, 8, "公网传感器接口")
    return ok

def queue_public_sensor_sync(rows):
    cfg = _read_local_cfg()
    token = cfg.get("worker_admin_token") or ""
    if not cfg.get("worker_admin_url") or len(token) < MIN_WORKER_ADMIN_TOKEN_LENGTH:
        return
    with _sensor_sync_lock:
        for row in rows:
            if row and row.get("channel"):
                key = (row.get("board"), row.get("channel"))
                _sensor_sync_pending[key] = row
    _start_sensor_sync_if_pending()


def _sensor_sync_worker():
    """后台线程：把队列里的快照批量发给 Worker。尽力而为——失败即丢弃，
    不影响本地采集；下一次心跳入队时会带回最新快照。"""
    while True:
        with _sensor_sync_lock:
            batch = list(_sensor_sync_pending.values())
            _sensor_sync_pending.clear()
            if not batch:
                _sensor_sync_running = False
                return
        sync_public_sensors(batch)


def _start_sensor_sync_if_pending():
    """若没有同步线程在跑则启动一个；空队列时无事可做。"""
    global _sensor_sync_running
    with _sensor_sync_lock:
        if _sensor_sync_running or not _sensor_sync_pending:
            return
        _sensor_sync_running = True
    threading.Thread(target=_sensor_sync_worker, name="sensor-sync", daemon=True).start()


def _password_record(password):
    """生成带版本和工作因子的 PBKDF2 密码记录。"""
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", (password or "").encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return {
        "salt": salt.hex(),
        "password_hash": digest.hex(),
        "password_scheme": PASSWORD_SCHEME,
        "password_iterations": PASSWORD_ITERATIONS,
    }


def _dummy_password_check(password):
    """未知/损坏账号也执行一次 PBKDF2，避免用响应时间枚举用户名。"""
    actual = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), _DUMMY_PASSWORD_SALT, PASSWORD_ITERATIONS
    ).hex()
    return secrets.compare_digest(actual, _DUMMY_PASSWORD_HASH)


def _set_admin_password(username, password, create=False):
    """更新账号密码；create=True 时允许创建新账号。"""
    record = _password_record(password)
    with _config_lock:
        cfg = _read_local_cfg()
        accounts = cfg.get("admin_accounts") or []
        for acc in accounts:
            if (acc.get("username") or "") == (username or ""):
                acc.update(record)
                ai_config_save({"admin_accounts": accounts})
                return True
        if create:
            record["username"] = username
            accounts.append(record)
            ai_config_save({"admin_accounts": accounts})
            return True
    return False


def admin_verify_password(username, password):
    """校验密码；旧 SHA-256 记录成功登录后自动升级为 PBKDF2。"""
    if not isinstance(password, str) or len(password) > 1024:
        return False
    cfg = _read_local_cfg()
    account = next((
        acc for acc in (cfg.get("admin_accounts") or [])
        if (acc.get("username") or "") == (username or "")
    ), None)
    if not account:
        _dummy_password_check(password)
        return False

    salt_text = account.get("salt") or ""
    expected = account.get("password_hash") or ""
    if not salt_text or not expected:
        _dummy_password_check(password)
        return False
    scheme = account.get("password_scheme") or "sha256"
    if scheme == PASSWORD_SCHEME:
        try:
            salt = bytes.fromhex(salt_text)
            iterations = int(account.get("password_iterations") or 0)
        except (TypeError, ValueError):
            _dummy_password_check(password)
            return False
        if len(salt) < 16 or not (100_000 <= iterations <= 10_000_000):
            _dummy_password_check(password)
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations
        ).hex()
        return secrets.compare_digest(actual, expected)
    if scheme == "sha256":
        # 旧记录只存在到首次成功迁移；先补一次 PBKDF2，使失败耗时不暴露账号状态。
        _dummy_password_check(password)
        actual = hashlib.sha256((salt_text + password).encode("utf-8")).hexdigest()
        valid = secrets.compare_digest(actual, expected)
        if valid:
            _set_admin_password(username, password)
        return valid
    _dummy_password_check(password)
    return False


def _prune_admin_fails():
    """海量 IP 刷登录时把失败记录内存封顶：先清过期锁定，仍超限则丢最旧一半。
    仅在 _admin_lock 内调用。"""
    if len(_admin_fails) <= ADMIN_FAILS_MAX_ENTRIES:
        return
    now = time.time()
    for key in [k for k, v in _admin_fails.items() if v[1] and v[1] <= now]:
        _admin_fails.pop(key, None)
    if len(_admin_fails) > ADMIN_FAILS_MAX_ENTRIES:
        half = len(_admin_fails) // 2
        for key in list(_admin_fails.keys())[:half]:
            _admin_fails.pop(key, None)


def admin_login(ip, username, password):
    """校验账号密码：成功发令牌；失败计数，超限锁定。返回 (ok, token或错误信息)。
    昂贵的密码校验在锁外执行（PBKDF2 60 万次迭代），锁只保护计数器与令牌表，
    避免并发刷登录时拖垮所有已登录请求的令牌校验。"""
    now = time.time()
    with _admin_lock:
        rec = _admin_fails.get(ip) or [0, 0]
        if rec[1] > now:
            # 未来时间戳钳制：锁定时间仅由本进程写入（now + 10 分钟），
            # 若因时钟回拨等异常出现远超上限的值，提示也按上限封顶。
            remaining = int(rec[1] - now)
            mins = min(int(remaining // 60) + 1, LOGIN_LOCK_SECONDS // 60)
            return False, "尝试次数过多，请 %d 分钟后再试" % mins
    if not admin_verify_password(username, password):
        with _admin_lock:
            rec = _admin_fails.get(ip) or [0, 0]
            rec[0] += 1
            if rec[0] >= LOGIN_MAX_FAILS:
                _admin_fails[ip] = [0, LOGIN_LOCK_SECONDS + time.time()]
                _prune_admin_fails()
                return False, "密码错误次数过多，已锁定 10 分钟"
            _admin_fails[ip] = rec
            _prune_admin_fails()
            return False, "用户名或密码错误（还可尝试 %d 次）" % (LOGIN_MAX_FAILS - rec[0])
    with _admin_lock:
        _admin_fails[ip] = [0, 0]
        token = secrets.token_hex(24)
        _admin_tokens[token] = time.time() + ADMIN_TOKEN_TTL
        return True, token


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


def _sensor_number(value, integer=False):
    if value in (None, "", "NA", "N/A", "null"):
        return None
    try:
        number = float(value)
        return int(number) if integer else number
    except (TypeError, ValueError):
        return None


def _sensor_timestamp(value):
    text = str(value or "").strip()
    if not text:
        return now_iso()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=CST)
        parsed = parsed.astimezone(CST)
        # 时钟偏差防护：未来超过 10 分钟的时间戳按当前时间收（不污染 14 天保留窗口）
        if parsed > datetime.now(CST) + timedelta(minutes=10):
            return now_iso()
        return parsed.isoformat(timespec="milliseconds")
    except ValueError:
        return now_iso()


def normalize_sensor_row(row, board=None):
    """把 JSON/CSV 输入统一成可存储、可公开同步的一行。"""
    source = dict(row or {})
    extra = source.pop("extra", {})
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {}
    if not isinstance(extra, dict):
        extra = {}

    sensor = str(source.get("sensor") or "").strip()[:80]
    channel = str(source.get("channel") or "").strip().upper()
    channel_index = _sensor_number(source.get("channel_index"), integer=True)
    if channel.isascii() and channel.isdigit():
        # isdigit 对全角数字（２/²/①）也返回 True，但 int() 只认 ASCII：
        # 先 isascii 过滤，避免未捕获 ValueError 打 500。
        channel_index = int(channel)
        channel = "CH" + channel
    if not channel and channel_index is not None:
        channel = "CH%d" % channel_index
    if not channel and sensor:
        channel = sensor.split()[0].upper()

    board_id = str(board or source.get("board") or "firefly-r1-1").strip()
    board_id = board_id[:80] or "firefly-r1-1"
    ok_value = source.get("ok")
    ok = 1 if ok_value in (None, 1, "1", True, "true", "True") else 0
    normalized = {
        "ts": _sensor_timestamp(source.get("ts")),
        "board": board_id,
        "uptime_ms": _sensor_number(source.get("uptime_ms"), integer=True),
        "cycle": _sensor_number(source.get("cycle"), integer=True),
        "channel": channel[:16] or None,
        "sensor": sensor or None,
        "ok": ok,
    }
    for name in SENSOR_VALUE_FIELDS:
        normalized[name] = _sensor_number(source.get(name))

    known = set(normalized) | {"channel_index"}
    for key, value in source.items():
        if key not in known:
            if key in SENSOR_TEXT_FIELDS:
                extra[key] = str(value).strip()[:80]
            else:
                extra[key] = (
                    _sensor_number(value) if key in SENSOR_CSV_FIELDS else value
                )
    if channel_index is not None:
        extra["channel_index"] = channel_index
    normalized["extra"] = extra
    return normalized


def sensor_row_public(row):
    result = dict(row)
    extra = result.pop("extra", {})
    if isinstance(extra, str):
        try:
            extra = json.loads(extra)
        except ValueError:
            extra = {}
    if isinstance(extra, dict):
        for key, value in extra.items():
            if key not in result:
                result[key] = value
    result.pop("id", None)
    return result


def ingest_json(row, board=None, con=None):
    """把一行 JSON 传感器数据写入 sensors 表并返回规范化结果。
    con 传入时由调用方统一提交（批量 ingest 一次事务）。"""
    normalized = normalize_sensor_row(row, board=board)
    if not normalized["channel"] or not normalized["sensor"]:
        return None
    own = con is None
    if own:
        con = db()
    con.execute(
        """INSERT INTO sensors(
            ts, board, uptime_ms, cycle, channel, sensor, ok,
            temp_c, rh_pct, pressure_pa,
            als_raw, uv_raw, voc_index, nox_index, co2_ppm, extra)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            normalized["ts"], normalized["board"], normalized["uptime_ms"],
            normalized["cycle"], normalized["channel"], normalized["sensor"],
            normalized["ok"], normalized["temp_c"], normalized["rh_pct"],
            normalized["pressure_pa"], normalized["als_raw"],
            normalized["uv_raw"], normalized["voc_index"],
            normalized["nox_index"], normalized["co2_ppm"],
            json.dumps(normalized["extra"], ensure_ascii=False),
        ),
    )
    if own:
        con.commit()
        con.close()
        maybe_prune_sensor_history()
    return sensor_row_public(normalized)


def ingest_csv_line(line, board=None, con=None):
    """解析固件原始 CSV 或 PC 监听器加过时间戳的 CSV 行。"""
    parts = line.rstrip("\r\n").split(",")
    if parts and parts[0] == "CSV":
        parts = parts[1:]
    if "uptime_ms" in parts or len(parts) < 6:
        return None
    ts = None
    if not parts[0].strip().isdigit():
        ts = parts.pop(0).strip()
    if len(parts) < 5:
        return None
    row = {
        name: parts[index].strip()
        for index, name in enumerate(SENSOR_CSV_FIELDS)
        if index < len(parts)
    }
    row["ts"] = ts or now_iso()
    row["channel"] = "CH" + str(row.get("channel_index", "")).strip()
    return ingest_json(row, board=board, con=con)


class Handler(BaseHTTPRequestHandler):
    server_version = "flitfancy/1.0"

    def log_message(self, fmt, *args):
        print("[%s] %s" % (now_iso(), fmt % args))

    def _send(self, code, body, content_type="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False)
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        if urllib.parse.urlparse(self.path).path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self, limit=1_000_000):
        raw = self.headers.get("Content-Length")
        try:
            length = int(raw) if raw is not None else 0
        except ValueError:
            return None
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
            if not self._remote_guard(path):
                return
            self._api_get(path, parsed.query)
            return
        self._serve_static(path)

    def do_POST(self):
        # 读超时：声明 Content-Length 后挂起不发的连接在 10 秒内被断开
        try:
            self.connection.settimeout(10)
        except OSError:
            pass
        parsed = urllib.parse.urlparse(self.path)
        # CSRF 防线一：现代浏览器的跨站请求必带 Sec-Fetch-Site: cross-site
        # （含 text/plain 简单请求），一律拒绝。
        # CSRF 防线二（旧浏览器兜底）：不发 Sec-Fetch-Site 但发 Origin 的请求，
        # Origin 必须与控制台同源，否则拒绝。感知板/监听脚本/curl 等非浏览器
        # 客户端两个头都没有，不受影响。
        sec_fetch = (self.headers.get("Sec-Fetch-Site") or "").lower()
        origin = (self.headers.get("Origin") or "").strip()
        if sec_fetch == "cross-site":
            self._send(403, {"ok": False, "error": "跨站请求被拒绝"})
            return
        if not sec_fetch and origin:
            host = (self.headers.get("Host") or "").strip()
            allowed_origins = {
                "http://" + host,
                "https://" + host,
                "https://console.flitfancy.com",
            }
            if origin not in allowed_origins:
                self._send(403, {"ok": False, "error": "跨站请求被拒绝"})
                return
        if not self._remote_guard(parsed.path):
            return
        if parsed.path == "/api/ingest":
            self._api_ingest()
        elif parsed.path == "/api/command":
            self._api_command()
        elif parsed.path == "/api/notes":
            self._api_note_create()
        elif parsed.path == "/api/memories":
            self._api_memory_create()
        elif parsed.path == "/api/anchors":
            self._api_anchor_create()
        elif parsed.path == "/api/reflections":
            self._api_reflection_create()
        elif parsed.path == "/api/memories/import-static":
            self._api_memories_import_static()
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

    def _is_remote(self):
        """只有“本机来源 IP + 精确本地 Host”才算本地；否则一律按远程处理。
        Host 精确匹配（去端口/去方括号/去尾点），防止 localhost.evil.com
        这类前缀域名 + DNS rebinding 绕过门卫。"""
        host = (self.headers.get("Host") or "").strip().lower().rstrip(".")
        if host.startswith("["):
            end = host.find("]")
            host = host[1:end] if end != -1 else host
        else:
            base, sep, port = host.rpartition(":")
            if sep and port.isdigit():
                host = base
        local_host = host in ("localhost", "127.0.0.1", "::1")
        client = self.client_address[0]
        local_ip = client in ("127.0.0.1", "::1")
        return not (local_host and local_ip)

    def _login_client_ip(self):
        """隧道请求按 Cloudflare 注入的真实访客 IP 分别计算登录失败次数。"""
        peer = self.client_address[0]
        try:
            peer_is_loopback = ipaddress.ip_address(peer).is_loopback
        except ValueError:
            peer_is_loopback = False
        if peer_is_loopback and self._is_remote():
            forwarded = (self.headers.get("CF-Connecting-IP") or "").strip()
            try:
                return ipaddress.ip_address(forwarded).compressed
            except ValueError:
                pass
        return peer

    def _remote_guard(self, path):
        """远程访问时，除登录接口外，所有 API 都必须先带管理员令牌。"""
        if not self._is_remote():
            return True
        if path == "/api/admin/login":
            return True
        if admin_token_valid(self._admin_token_from_request()):
            return True
        self._send(401, {"ok": False, "error": "远程访问需要先登录"})
        return False

    def _serve_static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        rel = path.lstrip("/")
        target = os.path.normpath(os.path.join(SITE_ROOT, rel))
        if os.path.commonpath([target, SITE_ROOT]) != SITE_ROOT or not os.path.isfile(target):
            self._send(404, {"error": "not found"}, "application/json; charset=utf-8")
            return
        ext = os.path.splitext(target)[1].lower()
        with open(target, "rb") as f:
            self._send(200, f.read(), MIME.get(ext, "application/octet-stream"))

    def _api_get(self, path, query=""):
        if path == "/api/status":
            n_sensors, n_notes = _status_counts()
            heartbeat = service_status()
            self._send(200, {
                "name": "flitfancy",
                "time": now_iso(),
                "services": {
                    "backend": True,
                    "listener": heartbeat["listener"],
                    "tunnel": heartbeat["tunnel"],
                },
                "sensor_rows": n_sensors,
                "sensor_retention_days": SENSOR_RETENTION_DAYS,
                "notes": n_notes,
                "chat_enabled": cfg_bool(_read_local_cfg().get("chat_enabled"), True),
                "protocol_name": protocol_name(),
                "msg": "flitfancy 在线 · 已记录 %d 条感知数据 · %d 条笔记" % (n_sensors, n_notes),
            })
        elif path == "/api/sensors/latest":
            con = db()
            rows = con.execute(
                """SELECT s.* FROM sensors s
                   JOIN (SELECT board, channel, MAX(id) AS mid FROM sensors
                         WHERE channel IS NOT NULL GROUP BY board, channel) m
                     ON s.id = m.mid
                   ORDER BY s.board, s.channel"""
            ).fetchall()
            con.close()
            self._send(200, {"rows": [sensor_row_public(dict(r)) for r in rows]})
        elif path == "/api/sensors/history":
            params = urllib.parse.parse_qs(query)
            channel = (params.get("channel") or [""])[0].strip().upper()
            hours_text = (params.get("hours") or [""])[0]
            hours = int(hours_text) if hours_text.isdigit() else 0
            if channel and 1 <= hours <= 72:
                # 24 小时总览：按 10 分钟桶聚合该通道的均值/最小/最大。
                self._send(200, {
                    "ok": True,
                    "channel": channel,
                    "hours": hours,
                    "buckets": compute_history_buckets(hours, channel),
                })
                return
            con = db()
            rows = con.execute(
                "SELECT * FROM sensors ORDER BY id DESC LIMIT 300"
            ).fetchall()
            con.close()
            self._send(200, {"rows": [sensor_row_public(dict(r)) for r in rows]})
        elif path == "/api/notes":
            con = db()
            rows = con.execute(
                "SELECT * FROM notes ORDER BY id DESC LIMIT 50"
            ).fetchall()
            con.close()
            self._send(200, {"rows": [dict(r) for r in rows]})
        elif path == "/api/memories":
            # 滞留记录的补传由后台 _history_sync_loop 负责，GET 不做外部同步
            # （避免每次打开页面都阻塞在 Worker 网络调用上）。
            con = db()
            rows = con.execute(
                "SELECT " + MEMORIES_SELECT + " FROM memories "
                "ORDER BY memory_time DESC, id DESC LIMIT 200"
            ).fetchall()
            con.close()
            self._send(200, {"ok": True, "rows": [dict(r) for r in rows]})
        elif path == "/api/anchors":
            # 滞留记录的补传由后台 _history_sync_loop 负责，GET 不做外部同步。
            con = db()
            rows = con.execute(
                """SELECT uid, anchor_time AS time, time_precision AS precision,
                          title, content, synced
                   FROM anchors ORDER BY anchor_time DESC, id DESC LIMIT 200"""
            ).fetchall()
            con.close()
            self._send(200, {"ok": True, "rows": [dict(r) for r in rows]})
        elif path == "/api/reflections":
            self._send(200, {
                "ok": True,
                "reflections": normalize_reflections(
                    _read_local_cfg().get("reflections") or []
                ),
            })
        elif path == "/api/admin/config":
            self._api_admin_config_get()
        elif path == "/api/visits":
            self._api_visits()
        else:
            self._send(404, {"error": "unknown api"})

    def _api_ingest(self):
        body = self._read_body()
        if not body:
            self._send(400, {"error": "empty body"})
            return
        text = body.decode("utf-8", errors="replace").strip()
        count = 0
        saved_rows = []
        board = (self.headers.get("X-Firefly-Board") or "").strip()[:80]
        con = db()
        if text.startswith("{"):
            try:
                data = json.loads(text)
            except ValueError:
                con.close()
                self._send(400, {"error": "bad json"})
                return
            rows = data if isinstance(data, list) else [data]
            for row in rows:
                saved = ingest_json(row, board=board or None, con=con)
                if saved:
                    saved_rows.append(saved)
                    count += 1
        else:
            for line in text.splitlines():
                saved = ingest_csv_line(line, board=board or None, con=con)
                if saved:
                    saved_rows.append(saved)
                    count += 1
        con.commit()
        con.close()
        maybe_prune_sensor_history()
        queue_public_sensor_sync(saved_rows)
        self._send(200, {"ok": True, "ingested": count})

    def _api_command(self):
        data = self._json_body()
        command = (data.get("command") or "").strip() if data else ""
        if not command or len(command) > 200:
            self._send(400, {"error": "command required (max 200 chars)"})
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

    def _api_memories_import_static(self):
        """把旅途页 HTML 里的老静态日记一次性导入本地库（幂等）：
        uid 由日期+序号确定生成，重复导入走 INSERT OR IGNORE 自动跳过。
        导入后随 sync_pending_memories 自动补传云端。"""
        data = self._json_body()
        if data is None:
            return
        entries = data.get("entries")
        if not isinstance(entries, list) or len(entries) > 200:
            self._send(400, {"error": "entries required"})
            return
        con = db()
        imported = 0
        for idx, item in enumerate(entries):
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            date_text = str(item.get("date") or "").strip()
            if not content or len(content) > 4000:
                continue
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date_text):
                continue
            uid = "static-%s-%03d" % (date_text, idx)
            cur = con.execute(
                """INSERT OR IGNORE INTO memories(
                       uid, created_at, memory_time, time_precision, memory_date,
                       perspective, source, title, content, synced
                   ) VALUES(?,?,?,?,?,?,?,?,?,0)""",
                (
                    uid, now_iso(), date_text + "T00:00:00+08:00", "date",
                    date_text, "me", "manual", "", content,
                ),
            )
            imported += cur.rowcount
        con.commit()
        con.close()
        if imported:
            sync_pending_memories()
        self._send(200, {"ok": True, "imported": imported})

    def _api_memory_create(self):
        data = self._json_body()
        if data is None:
            return
        perspective = (data.get("perspective") or "").strip()
        source = (data.get("source") or "manual").strip()
        memory_time_text = (data.get("time") or "").strip()
        legacy_date = (data.get("date") or "").strip()
        legacy_title = (data.get("title") or "").strip()
        content = (data.get("content") or "").strip()
        time_precision = "second"
        if not memory_time_text and legacy_date:
            try:
                datetime.strptime(legacy_date, "%Y-%m-%d")
            except (TypeError, ValueError):
                self._send(400, {"ok": False, "error": "date 必须是 YYYY-MM-DD"})
                return
            memory_time_text = legacy_date + "T00:00:00+08:00"
            time_precision = "date"
        # 时间宽松归一：接受"仅日期""到分钟""完整"三种粒度，
        # 缺省部分补齐（输入框本应给完整秒，此处理兜底手输与旧数据）。
        try:
            if len(memory_time_text) == 10:
                datetime.strptime(memory_time_text, "%Y-%m-%d")
                memory_time_text += "T00:00:00+08:00"
                time_precision = "date"
            elif len(memory_time_text) == 16 and memory_time_text[10] == "T":
                datetime.strptime(memory_time_text, "%Y-%m-%dT%H:%M")
                memory_time_text += ":00+08:00"
            parsed_time = datetime.fromisoformat(memory_time_text.replace("Z", "+00:00"))
            if parsed_time.tzinfo is None:
                parsed_time = parsed_time.replace(tzinfo=CST)
            memory_time = parsed_time.astimezone(CST).isoformat(timespec="seconds")
        except (TypeError, ValueError):
            self._send(400, {
                "ok": False,
                "error": "time 格式不正确，例如 2026-08-13T21:30:05",
            })
            return
        if perspective not in ("me", "her"):
            self._send(400, {"ok": False, "error": "perspective 必须是 me 或 her"})
            return
        if source not in ("manual", "firefly"):
            self._send(400, {"ok": False, "error": "source 必须是 manual 或 firefly"})
            return
        # 兼容旧插件的 title + content，请求进入后统一折叠为一个 content。
        if legacy_title and legacy_title != ".":
            content = legacy_title + (("\n" + content) if content else "")
        if not content or len(content) > 4000:
            self._send(400, {"ok": False, "error": "内容不能为空，且不能超过 4000 字"})
            return

        # 带 uid = 编辑既有条目；不带 = 新建。两条路径共用同一套校验。
        edit_uid = (data.get("uid") or "").strip()
        if edit_uid and not re.match(r"^[a-zA-Z0-9_-]{16,80}$", edit_uid):
            self._send(400, {"ok": False, "error": "invalid uid"})
            return
        con = db()
        if edit_uid:
            cur = con.execute(
                """UPDATE memories SET memory_time=?, time_precision=?, memory_date=?,
                       perspective=?, source=?, content=?, synced=0 WHERE uid=?""",
                (
                    memory_time, time_precision, memory_time[:10],
                    perspective, source, content, edit_uid,
                ),
            )
            con.commit()
            con.close()
            if cur.rowcount == 0:
                self._send(404, {"ok": False, "error": "要编辑的日记不存在"})
                return
            uid_value = edit_uid
            updated = True
        else:
            record = {
                "uid": secrets.token_hex(16),
                "created_at": now_iso(),
                "memory_time": memory_time,
                "time_precision": time_precision,
                "memory_date": memory_time[:10],
                "perspective": perspective,
                "source": source,
                "title": "",
                "content": content,
            }
            con.execute(
                """INSERT INTO memories(
                       uid, created_at, memory_time, time_precision, memory_date, perspective,
                       source, title, content, synced
                   ) VALUES(?,?,?,?,?,?,?,?,?,0)""",
                (
                    record["uid"], record["created_at"], record["memory_time"],
                    record["time_precision"], record["memory_date"], record["perspective"],
                    record["source"], record["title"], record["content"],
                ),
            )
            con.commit()
            con.close()
            uid_value = record["uid"]
            updated = False

        _, sync_note = sync_pending_memories()
        con = db()
        saved = con.execute(
            """SELECT uid, memory_time AS time, time_precision AS precision,
                      perspective, content, synced
               FROM memories WHERE uid = ?""",
            (uid_value,),
        ).fetchone()
        con.close()
        saved = dict(saved)
        self._send(200 if updated else 201, {
            "ok": True,
            "updated": updated,
            "memory": saved,
            "public_sync": bool(saved["synced"]),
            "public_sync_note": sync_note,
        })


    def _api_anchor_create(self):
        data = self._json_body()
        if data is None:
            return
        title = str(data.get("title") or "").strip()
        content = str(data.get("content") or "").strip()
        anchor_time = str(data.get("time") or "").strip()
        if not title or not content:
            self._send(400, {"error": "标题和内容都要填写"})
            return
        if len(title) > 120 or len(content) > 4000:
            self._send(400, {"error": "标题或内容过长"})
            return
        time_precision = "second"
        if not anchor_time:
            anchor_time = now_iso()
        elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", anchor_time):
            anchor_time += "T00:00:00+08:00"
            time_precision = "date"
        if not re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?",
            anchor_time,
        ):
            self._send(400, {"error": "时间格式不正确"})
            return
        if not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", anchor_time):
            anchor_time += "+08:00"
        # 带 uid = 编辑既有锚点；不带 = 新建。
        edit_uid = (data.get("uid") or "").strip()
        if edit_uid and not re.match(r"^[a-zA-Z0-9_-]{16,80}$", edit_uid):
            self._send(400, {"ok": False, "error": "invalid uid"})
            return
        con = db()
        if edit_uid:
            cur = con.execute(
                """UPDATE anchors SET anchor_time=?, time_precision=?, title=?, content=?,
                       synced=0 WHERE uid=?""",
                (anchor_time, time_precision, title, content, edit_uid),
            )
            con.commit()
            con.close()
            if cur.rowcount == 0:
                self._send(404, {"ok": False, "error": "要编辑的锚点不存在"})
                return
            uid_value = edit_uid
            updated = True
        else:
            record = {
                "uid": secrets.token_hex(16),
                "created_at": now_iso(),
                "anchor_time": anchor_time,
                "time_precision": time_precision,
                "title": title,
                "content": content,
            }
            con.execute(
                """INSERT INTO anchors(
                       uid, created_at, anchor_time, time_precision, title, content, synced
                   ) VALUES(?,?,?,?,?,?,0)""",
                (
                    record["uid"], record["created_at"], record["anchor_time"],
                    record["time_precision"], record["title"], record["content"],
                ),
            )
            con.commit()
            con.close()
            uid_value = record["uid"]
            updated = False

        _, sync_note = sync_pending_anchors()
        con = db()
        saved = con.execute(
            """SELECT uid, anchor_time AS time, time_precision AS precision,
                      title, content, synced
               FROM anchors WHERE uid = ?""",
            (uid_value,),
        ).fetchone()
        con.close()
        saved = dict(saved)
        self._send(200 if updated else 201, {
            "ok": True,
            "updated": updated,
            "anchor": saved,
            "public_sync": bool(saved["synced"]),
            "public_sync_note": sync_note,
        })

    def _api_reflection_create(self):
        data = self._json_body()
        if data is None:
            return
        cfg = _read_local_cfg()
        # 两种负载：{"content": "…"} 追加一条（页脚快速入口，向后兼容）；
        # {"reflections": ["…"]} 整表替换（编辑器列表保存，含清空）。
        # 两种都过同一 normalize 源头规则：去空/去重/截 120 字。
        if isinstance(data.get("reflections"), list):
            rows = normalize_reflections(data["reflections"])
        else:
            text = str(data.get("content") or "").strip()[:120]
            if not text:
                self._send(400, {"error": "随笔内容不能为空"})
                return
            rows = normalize_reflections((cfg.get("reflections") or []) + [text])
        ai_config_save({"reflections": rows})
        ok, note = sync_public_config({"reflections": rows})
        self._send(201, {
            "ok": True,
            "reflections": rows,
            "public_sync": ok,
            "public_sync_note": note,
        })

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
            and len(m["content"]) <= 4000
        ][-20:]
        if not messages:
            self._send(400, {"error": "messages required"})
            return
        if not cfg_bool(_read_local_cfg().get("chat_enabled"), True):
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
        ok, payload = admin_login(self._login_client_ip(), username, password)
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
            "chat_enabled": cfg_bool(cfg.get("chat_enabled"), True),
            "quick_links": cfg.get("quick_links") or [],
            "reflections": normalize_reflections(cfg.get("reflections") or []),
        })

    def _fetch_worker_json(self, endpoint):
        """带着管理员令牌请求公网 Worker（api.flitfancy.com）并返回 JSON。"""
        cfg = _read_local_cfg()
        url = cfg.get("worker_admin_url") or ""
        token = cfg.get("worker_admin_token") or ""
        if not url or not token:
            self._send(502, {
                "ok": False,
                "error": "未配置公网地址（ai_local.json 的 worker_admin_url/token）",
            })
            return None
        if len(token) < MIN_WORKER_ADMIN_TOKEN_LENGTH:
            self._send(502, {
                "ok": False,
                "error": "公网管理令牌长度不足（至少 32 个字符）",
            })
            return None
        req = urllib.request.Request(
            url.rstrip("/") + endpoint,
            headers={
                "Authorization": "Bearer " + token,
                "User-Agent": WORKER_UA,
            },
        )
        try:
            with AI_OPENER.open(req, timeout=8) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:300]
            self._send(502, {
                "ok": False,
                "error": "公网访问记录接口返回 %d" % e.code,
                "detail": detail,
            })
            return None
        except Exception as e:
            self._send(502, {
                "ok": False,
                "error": "访问记录获取失败：%s" % e,
            })
            return None

    def _api_visits(self):
        if self._require_admin() is None:
            return
        data = self._fetch_worker_json("/visits")
        if data is not None:
            self._send(200, data)

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
            updates["chat_enabled"] = cfg_bool(data["chat_enabled"], True)
        if "quick_links" in data and isinstance(data["quick_links"], list):
            links = []
            for item in data["quick_links"][:50]:
                if isinstance(item, dict) and item.get("name") and item.get("url"):
                    url = str(item["url"]).strip()
                    if not url.startswith(("http://", "https://")):
                        continue
                    links.append({
                        "name": str(item["name"])[:60],
                        "url": url[:300],
                    })
            updates["quick_links"] = links
        if "reflections" in data:
            if not isinstance(data["reflections"], list):
                self._send(400, {"ok": False, "error": "随笔必须是句子列表"})
                return
            updates["reflections"] = normalize_reflections(data["reflections"])
        ai_config_save(updates)
        cfg = _read_local_cfg()
        sync_ok = True
        sync_note = ""
        public_updates = {}
        if "chat_enabled" in updates:
            public_updates["chat_enabled"] = cfg_bool(updates["chat_enabled"], True)
        if "reflections" in updates:
            public_updates["reflections"] = updates["reflections"]
        if public_updates:
            sync_ok, sync_note = sync_public_config(public_updates)
        self._send(200, {
            "ok": True,
            "model": cfg.get("model") or "",
            "chat_enabled": cfg_bool(cfg.get("chat_enabled"), True),
            "quick_links": cfg.get("quick_links") or [],
            "reflections": normalize_reflections(cfg.get("reflections") or []),
            "public_sync": sync_ok,
            "public_sync_note": sync_note,
        })


class FlitFancyServer(ThreadingHTTPServer):
    """带并发上限的线程服务器：超出 32 个活动连接时直接断开新连接，
    防止 slowloris/连接风暴耗尽线程与句柄。"""
    daemon_threads = True
    _slots = threading.BoundedSemaphore(32)

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()
            return
        # slowloris 防护：槽位只限并发数，这里再给连接设读超时——
        # 覆盖头阶段（读请求行/请求头）与体阶段（rfile.read），
        # 拖慢速读的连接到点即断，不占线程。
        try:
            request.settimeout(REQUEST_READ_TIMEOUT)
        except OSError:
            pass
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()


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
        if len(new_pwd) < MIN_NEW_PASSWORD_LENGTH:
            print("新密码至少 %d 位，未修改" % MIN_NEW_PASSWORD_LENGTH)
            sys.exit(1)
        _set_admin_password(username, new_pwd, create=True)
        print("账号 %s 的密码已更新（本地只存哈希，不存明文）" % username)
        return
    db_init()
    threading.Thread(
        target=_history_sync_loop, name="history-public-sync", daemon=True
    ).start()
    server = FlitFancyServer((HOST, PORT), Handler)
    print("flitfancy 控制台服务已启动: http://localhost:%d/" % PORT)
    print("前端目录: %s" % SITE_ROOT)
    print("数据文件: %s" % DB_PATH)
    print("SQLite 感知明细保留: 最近 %d 天" % SENSOR_RETENTION_DAYS)
    print("原始感知数据永久目录: %s" % SENSOR_RAW_DATA_DIR)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
