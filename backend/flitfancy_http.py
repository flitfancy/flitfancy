"""FlitFancy HTTP 路由与请求边界；领域能力通过显式依赖注入。"""

import ipaddress
import json
import os
import re
import secrets
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from http.server import BaseHTTPRequestHandler

@dataclass(frozen=True)
class HttpDependencies:
    ai_opener: object
    cst: object
    memories_select: str
    mime: dict
    sensor_retention_days: int
    site_root: str
    read_local_config: object
    status_counts: object
    worker_client: object
    admin_login: object
    admin_logout: object
    admin_token_valid: object
    ai_config: object
    ai_config_save: object
    base_url_for_model: object
    cfg_bool: object
    compute_history_buckets: object
    db: object
    ingest_csv_line: object
    ingest_json: object
    maybe_prune_sensor_history: object
    normalize_reflections: object
    observation_service: object
    now_iso: object
    protocol_name: object
    queue_public_sensor_sync: object
    sensor_row_public: object
    service_status: object
    sync_pending_anchors: object
    sync_pending_essays: object
    sync_pending_memories: object
    sync_public_config: object


def create_handler(app):
    """创建只可访问已声明领域能力的请求处理器。"""
    AI_OPENER = app.ai_opener
    CST = app.cst
    MEMORIES_SELECT = app.memories_select
    MIME = app.mime
    SENSOR_RETENTION_DAYS = app.sensor_retention_days
    SITE_ROOT = app.site_root
    _read_local_cfg = app.read_local_config
    _status_counts = app.status_counts
    _worker_client = app.worker_client
    admin_login = app.admin_login
    admin_logout = app.admin_logout
    admin_token_valid = app.admin_token_valid
    ai_config = app.ai_config
    ai_config_save = app.ai_config_save
    base_url_for_model = app.base_url_for_model
    cfg_bool = app.cfg_bool
    compute_history_buckets = app.compute_history_buckets
    db = app.db
    ingest_csv_line = app.ingest_csv_line
    ingest_json = app.ingest_json
    maybe_prune_sensor_history = app.maybe_prune_sensor_history
    normalize_reflections = app.normalize_reflections
    observation_service = app.observation_service
    now_iso = app.now_iso
    protocol_name = app.protocol_name
    queue_public_sensor_sync = app.queue_public_sensor_sync
    sensor_row_public = app.sensor_row_public
    service_status = app.service_status
    sync_pending_anchors = app.sync_pending_anchors
    sync_pending_essays = app.sync_pending_essays
    sync_pending_memories = app.sync_pending_memories
    sync_public_config = app.sync_public_config

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
            elif parsed.path == "/api/essays":
                self._api_essay_create()
            elif parsed.path == "/api/observations":
                self._api_observation_create()
            elif parsed.path == "/api/observation-links":
                self._api_observation_link_create()
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
                              horizon, project, title, content, synced
                       FROM anchors ORDER BY anchor_time DESC, id DESC LIMIT 200"""
                ).fetchall()
                con.close()
                self._send(200, {"ok": True, "rows": [dict(r) for r in rows]})
            elif path == "/api/essays":
                con = db()
                rows = con.execute(
                    """SELECT uid, created_at, updated_at, title, content, display_order
                       FROM essays WHERE status = 'public'
                       ORDER BY display_order ASC, updated_at DESC, id DESC LIMIT 100"""
                ).fetchall()
                con.close()
                self._send(200, {"ok": True, "rows": [dict(r) for r in rows]})
            elif path == "/api/admin/essays":
                if self._require_admin() is None:
                    return
                con = db()
                rows = con.execute(
                    """SELECT uid, created_at, updated_at, title, content,
                              status, display_order, synced
                       FROM essays
                       ORDER BY CASE status WHEN 'public' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                                display_order ASC, updated_at DESC, id DESC LIMIT 200"""
                ).fetchall()
                con.close()
                self._send(200, {"ok": True, "rows": [dict(r) for r in rows]})
            elif path == "/api/observations":
                self._send(200, observation_service.public_catalog())
            elif path == "/api/admin/observations":
                if self._require_admin() is None:
                    return
                self._send(200, observation_service.admin_observations())
            elif path == "/api/admin/observation-links":
                if self._require_admin() is None:
                    return
                self._send(200, observation_service.admin_links())
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
            if "date" in data or "title" in data:
                self._send(400, {
                    "ok": False,
                    "error": "date/title 已停止支持，请使用 time/content",
                })
                return
            perspective = (data.get("perspective") or "").strip()
            source = (data.get("source") or "manual").strip()
            memory_time_text = (data.get("time") or "").strip()
            content = (data.get("content") or "").strip()
            time_precision = "second"
            # 时间宽松归一：接受"仅日期""到分钟""完整"三种粒度，
            # 缺省部分补齐（输入框本应给完整秒，此处理兜底手输）。
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
            horizon = str(data.get("horizon") or "").strip()
            project = str(data.get("project") or "").strip()
            if not title or not content:
                self._send(400, {"error": "标题和内容都要填写"})
                return
            if len(title) > 120 or len(content) > 4000:
                self._send(400, {"error": "标题或内容过长"})
                return
            if horizon not in ("now", "future"):
                self._send(400, {"error": "时间视角必须是 now 或 future"})
                return
            if project not in ("firefly", "skywork", "flitfancy"):
                self._send(400, {"error": "请选择锚点所属项目"})
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
                    """UPDATE anchors SET anchor_time=?, time_precision=?, horizon=?, project=?,
                           title=?, content=?, synced=0 WHERE uid=?""",
                    (anchor_time, time_precision, horizon, project,
                     title, content, edit_uid),
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
                    "horizon": horizon,
                    "project": project,
                    "title": title,
                    "content": content,
                }
                con.execute(
                    """INSERT INTO anchors(
                           uid, created_at, anchor_time, time_precision, horizon, project,
                           title, content, synced
                       ) VALUES(?,?,?,?,?,?,?,?,0)""",
                    (
                        record["uid"], record["created_at"], record["anchor_time"],
                        record["time_precision"], record["horizon"], record["project"],
                        record["title"], record["content"],
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
                          horizon, project, title, content, synced
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

        def _api_essay_create(self):
            data = self._json_body()
            if data is None:
                return
            title = str(data.get("title") or "").strip()
            content = str(data.get("content") or "").strip()
            status = str(data.get("status") or "draft").strip()
            try:
                display_order = int(data.get("display_order", 100))
            except (TypeError, ValueError):
                self._send(400, {"error": "展示顺序必须是整数"})
                return
            display_order = max(0, min(display_order, 9999))
            if not title or not content:
                self._send(400, {"error": "标题和正文都要填写"})
                return
            if len(title) > 120 or len(content) > 12000:
                self._send(400, {"error": "标题或正文过长"})
                return
            if status not in ("draft", "public", "archived"):
                self._send(400, {"error": "短文状态不正确"})
                return
            edit_uid = str(data.get("uid") or "").strip()
            if edit_uid and not re.match(r"^[a-zA-Z0-9_-]{16,80}$", edit_uid):
                self._send(400, {"ok": False, "error": "invalid uid"})
                return
            updated_at = now_iso()
            con = db()
            if edit_uid:
                cur = con.execute(
                    """UPDATE essays SET updated_at=?, title=?, content=?, status=?,
                           display_order=?, synced=0 WHERE uid=?""",
                    (updated_at, title, content, status, display_order, edit_uid),
                )
                con.commit()
                con.close()
                if cur.rowcount == 0:
                    self._send(404, {"ok": False, "error": "要编辑的短文不存在"})
                    return
                uid_value = edit_uid
                updated = True
            else:
                uid_value = secrets.token_hex(16)
                con.execute(
                    """INSERT INTO essays(
                           uid, created_at, updated_at, title, content,
                           status, display_order, synced
                       ) VALUES(?,?,?,?,?,?,?,0)""",
                    (uid_value, updated_at, updated_at, title, content,
                     status, display_order),
                )
                con.commit()
                con.close()
                updated = False
            _, sync_note = sync_pending_essays()
            con = db()
            saved = con.execute(
                """SELECT uid, created_at, updated_at, title, content,
                          status, display_order, synced
                   FROM essays WHERE uid = ?""",
                (uid_value,),
            ).fetchone()
            con.close()
            saved = dict(saved)
            self._send(200 if updated else 201, {
                "ok": True,
                "updated": updated,
                "essay": saved,
                "public_sync": bool(saved["synced"]),
                "public_sync_note": sync_note,
            })

        def _api_observation_create(self):
            data = self._json_body()
            if data is None:
                return
            status, payload = observation_service.save_observation(data)
            self._send(status, payload)

        def _api_observation_link_create(self):
            data = self._json_body()
            if data is None:
                return
            status, payload = observation_service.save_link(data)
            self._send(status, payload)

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
            data, error, detail = _worker_client.get_json(endpoint)
            if error:
                payload = {"ok": False, "error": error}
                if detail:
                    payload["detail"] = detail
                self._send(502, payload)
                return None
            return data

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



    return Handler
