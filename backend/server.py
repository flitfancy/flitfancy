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
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime
from http.server import ThreadingHTTPServer

from flitfancy_auth import AdminAuth, MIN_NEW_PASSWORD_LENGTH
from flitfancy_core import (
    CST,
    base_url_for_model,
    cfg_bool,
    normalize_protocol_name,
    normalize_reflections,
    now_iso,
)
from flitfancy_http import HttpDependencies, create_handler
from flitfancy_observations import ObservationService, decode_tags
from flitfancy_sensors import (
    normalize_sensor_row,
    parse_sensor_csv_line,
    sensor_row_public,
)
from flitfancy_storage import SQLiteStore
from flitfancy_sync import LatestSensorSyncQueue, WorkerClient


def _env_int(name, default, minimum=0):
    try:
        value = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default
    return max(minimum, value)


BASE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.path.normpath(os.path.join(BASE, "..", "docs"))
DB_PATH = os.environ.get("FLITFANCY_DB_PATH") or os.path.join(BASE, "data", "flitfancy.db")
SENSOR_RAW_DATA_DIR = os.path.normpath(os.path.join(BASE, "..", "data", "sensors"))
# 默认只监听回环：LAN 侧入口只有监听器（7777，供感知板推送），
# 后端 2671 供 cloudflared 隧道与本地浏览器使用，无需暴露局域网。
HOST = os.environ.get("FLITFANCY_HOST") or "127.0.0.1"
PORT = int(os.environ.get("FLITFANCY_PORT") or "2671")
SENSOR_RETENTION_DAYS = _env_int("FLITFANCY_SENSOR_RETENTION_DAYS", 14, 1)
SENSOR_PRUNE_INTERVAL_SECONDS = _env_int(
    "FLITFANCY_SENSOR_PRUNE_INTERVAL_SECONDS", 3600, 0,
)

AI_CONFIG_PATH = os.environ.get("FLITFANCY_AI_CONFIG_PATH") or os.path.join(BASE, "ai_local.json")

# 直连 AI 服务，不走系统/环境代理（本机 git 代理是给 GitHub 用的）
AI_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

REQUEST_READ_TIMEOUT = 10            # slowloris 防护：请求头/体读取阶段最长等待秒数
_config_lock = threading.RLock()

_store = SQLiteStore(
    DB_PATH,
    sensor_retention_days=SENSOR_RETENTION_DAYS,
    prune_interval_seconds=SENSOR_PRUNE_INTERVAL_SECONDS,
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


def compute_history_buckets(hours, channel=None):
    return _store.compute_history_buckets(hours, channel)


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
        sync_pending_essays()
        sync_pending_observations()
        sync_pending_observation_links()
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
    return _store.connect()


def db_init():
    _store.initialize()


def prune_sensor_history():
    return _store.prune_sensor_history()


def maybe_prune_sensor_history(force=False):
    return _store.maybe_prune(force=force)


_protocol_name_cache = {"t": 0.0, "name": ""}


def protocol_name():
    r"""读取安装脚本注册的随机协议名（HKCU\Software\FlitFancy\ProtocolName）。
    60 秒缓存；非法或未安装时返回空串，让前端保持服务按钮禁用。"""
    now = time.monotonic()
    if _protocol_name_cache["t"] and now - _protocol_name_cache["t"] < 60:
        return _protocol_name_cache["name"]
    name = ""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\FlitFancy") as key:
            value, _ = winreg.QueryValueEx(key, "ProtocolName")
            name = normalize_protocol_name(value)
    except Exception:
        name = ""
    _protocol_name_cache["t"] = now
    _protocol_name_cache["name"] = name
    return name


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


_admin_auth = AdminAuth(
    read_config=_read_local_cfg,
    save_config=ai_config_save,
    config_lock=_config_lock,
)
# 仅供既有诊断/冒烟测试观察失败锁定状态；认证实现由 AdminAuth 单点维护。
_admin_fails = _admin_auth.failures


_worker_client = WorkerClient(_read_local_cfg, AI_OPENER)


def worker_post(endpoint, payload, timeout=8, error_label="公网接口"):
    return _worker_client.post(endpoint, payload, timeout, error_label)


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
        "horizon": anchor["horizon"],
        "project": anchor["project"],
        "title": anchor["title"],
        "content": anchor["content"],
    }
    return worker_post("/admin/anchors", payload, 8, "公网锚点接口")


def sync_public_essay(essay):
    """公开短文同步内容；草稿和归档只发送撤下指令，不上传正文。"""
    published = essay["status"] == "public"
    payload = {
        "uid": essay["uid"],
        "published": published,
    }
    if published:
        payload.update({
            "created_at": essay["created_at"],
            "updated_at": essay["updated_at"],
            "title": essay["title"],
            "content": essay["content"],
            "display_order": essay["display_order"],
        })
    return worker_post("/admin/essays", payload, 8, "公网短文接口")


def sync_public_observation(observation):
    """只把公开星球同步到 Worker；草稿和归档发送撤下指令。"""
    published = observation["status"] == "public"
    payload = {"uid": observation["uid"], "published": published}
    if published:
        payload.update({
            "created_at": observation["created_at"],
            "updated_at": observation["updated_at"],
            "title": observation["title"],
            "category": observation["category"],
            "tags": decode_tags(observation["tags_json"]),
            "summary": observation["summary"],
            "content": observation["content"],
            "discovered_at": observation["discovered_at"],
            "source_name": observation["source_name"],
            "source_url": observation["source_url"],
        })
    return worker_post("/admin/observations", payload, 8, "公网见闻接口")


def sync_public_observation_link(link):
    """只有弦的两端均公开时才在 Worker 保留公开副本。"""
    con = db()
    statuses = con.execute(
        "SELECT uid, status FROM observations WHERE uid IN (?, ?)",
        (link["source_uid"], link["target_uid"]),
    ).fetchall()
    con.close()
    published = len(statuses) == 2 and all(row["status"] == "public" for row in statuses)
    payload = {"uid": link["uid"], "published": published}
    if published:
        payload.update({
            "created_at": link["created_at"],
            "updated_at": link["updated_at"],
            "source_uid": link["source_uid"],
            "target_uid": link["target_uid"],
            "relation": link["relation"],
        })
    return worker_post("/admin/observation-links", payload, 8, "公网星弦接口")


# 补传 SQL 白名单：表名不再参与字符串格式化，杜绝未来调用方传入
# 非常量表名的可能。键集合与 sync_pending_* 系列入口一一对应。
_SYNC_PENDING_SQL = {
    "anchors": (
        "SELECT * FROM anchors WHERE synced = 0 ORDER BY id LIMIT ?",
        "UPDATE anchors SET synced = 1 WHERE uid = ?",
    ),
    "memories": (
        "SELECT * FROM memories WHERE synced = 0 ORDER BY id LIMIT ?",
        "UPDATE memories SET synced = 1 WHERE uid = ?",
    ),
    "essays": (
        "SELECT * FROM essays WHERE synced = 0 ORDER BY id LIMIT ?",
        "UPDATE essays SET synced = 1 WHERE uid = ?",
    ),
    "observations": (
        "SELECT * FROM observations WHERE synced = 0 ORDER BY id LIMIT ?",
        "UPDATE observations SET synced = 1 WHERE uid = ?",
    ),
    "observation_links": (
        "SELECT * FROM observation_links WHERE synced = 0 ORDER BY id LIMIT ?",
        "UPDATE observation_links SET synced = 1 WHERE uid = ?",
    ),
}


def _sync_pending_rows(table, pusher, limit):
    """重试补传 synced=0 的滞留记录（锚点/日记/短文/见闻共用）：
    逐条推送，失败即停（不重试风暴），成功后落 synced=1。"""
    try:
        select_sql, mark_sql = _SYNC_PENDING_SQL[table]
    except KeyError:
        raise ValueError(f"unknown sync table: {table}") from None
    con = db()
    rows = con.execute(select_sql, (limit,)).fetchall()
    con.close()
    synced = 0
    note = ""
    for row in rows:
        ok, note = pusher(dict(row))
        if not ok:
            break
        con = db()
        con.execute(mark_sql, (row["uid"],))
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


def sync_pending_essays(limit=20):
    """同步公开短文或撤下已转为草稿/归档的公网副本。"""
    return _sync_pending_rows("essays", sync_public_essay, limit)


def sync_pending_observations(limit=20):
    """同步公开星球或撤下草稿、归档的公网副本。"""
    return _sync_pending_rows("observations", sync_public_observation, limit)


def sync_pending_observation_links(limit=40):
    """同步两端均公开的弦，其他弦只发送撤下指令。"""
    return _sync_pending_rows("observation_links", sync_public_observation_link, limit)


def sync_public_sensors(rows):
    """把一批最新传感器快照同步到 Worker。网络失败不影响本地采集。"""
    if not rows:
        return False
    ok, _ = worker_post("/admin/sensors", {"rows": rows}, 8, "公网传感器接口")
    return ok

def queue_public_sensor_sync(rows):
    _sensor_sync_queue.enqueue(rows)


_sensor_sync_queue = LatestSensorSyncQueue(
    ready=_worker_client.ready,
    sender=sync_public_sensors,
)


def _set_admin_password(username, password, create=False):
    return _admin_auth.set_password(username, password, create=create)


def admin_login(ip, username, password):
    return _admin_auth.login(ip, username, password)


def admin_token_valid(token):
    return _admin_auth.token_valid(token)


def admin_logout(token):
    _admin_auth.logout(token)


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
    row = parse_sensor_csv_line(line)
    if row is None:
        return None
    return ingest_json(row, board=board, con=con)


_observation_service = ObservationService(
    db, now_iso, sync_pending_observations, sync_pending_observation_links,
)

Handler = create_handler(HttpDependencies(
    ai_opener=AI_OPENER,
    cst=CST,
    memories_select=MEMORIES_SELECT,
    mime=MIME,
    sensor_retention_days=SENSOR_RETENTION_DAYS,
    site_root=SITE_ROOT,
    read_local_config=_read_local_cfg,
    status_counts=_status_counts,
    worker_client=_worker_client,
    admin_login=admin_login,
    admin_logout=admin_logout,
    admin_token_valid=admin_token_valid,
    ai_config=ai_config,
    ai_config_save=ai_config_save,
    base_url_for_model=base_url_for_model,
    cfg_bool=cfg_bool,
    compute_history_buckets=compute_history_buckets,
    db=db,
    ingest_csv_line=ingest_csv_line,
    ingest_json=ingest_json,
    maybe_prune_sensor_history=maybe_prune_sensor_history,
    normalize_reflections=normalize_reflections,
    observation_service=_observation_service,
    now_iso=now_iso,
    protocol_name=protocol_name,
    queue_public_sensor_sync=queue_public_sensor_sync,
    sensor_row_public=sensor_row_public,
    service_status=service_status,
    sync_pending_anchors=sync_pending_anchors,
    sync_pending_essays=sync_pending_essays,
    sync_pending_memories=sync_pending_memories,
    sync_public_config=sync_public_config,
))
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
