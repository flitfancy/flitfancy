"""Worker 管理请求客户端与最新传感器快照同步队列。"""

import copy
import json
import threading
import urllib.error
import urllib.request


MIN_WORKER_ADMIN_TOKEN_LENGTH = 32
WORKER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


class PublicContentSyncQueue:
    """Durable outbox for public reflections and the selected essay snapshot.

    The metadata is saved in the same atomic config-file replacement as the value.
    No credentials or private chat settings are sent by this queue.
    """
    KEYS = ("reflections", "featured_essay")
    META = "_public_content_sync"

    def __init__(self, read_config, save_config, lock, send):
        self.read_config = read_config
        self.save_config = save_config
        self.lock = lock
        self.send = send

    @classmethod
    def record_changes(cls, config, updates, now_microseconds):
        keys = [key for key in cls.KEYS if key in updates]
        if not keys:
            return
        meta = copy.deepcopy(config.get(cls.META) or {})
        items = meta.setdefault("items", {})
        clock = int(meta.get("clock") or 0)
        for key in keys:
            clock = max(clock + 1, int(now_microseconds))
            items[key] = {"revision": clock}
        meta["clock"] = clock
        config[cls.META] = meta

    def flush(self, keys=None):
        selected = tuple(key for key in (keys or self.KEYS) if key in self.KEYS)
        note = ""
        for key in selected:
            with self.lock:
                cfg = self.read_config()
                item = (cfg.get(self.META) or {}).get("items", {}).get(key)
                if not item or key not in cfg:
                    continue
                revision = item.get("revision")
                value = copy.deepcopy(cfg[key])
            ok, detail = self.send("/admin/content-config", {
                "key": key, "value": value, "sync_revision": revision,
            }, 8, "公网内容配置接口")
            if not ok:
                note = detail or "公网内容配置尚未确认"
                continue
            with self.lock:
                cfg = self.read_config()
                meta = copy.deepcopy(cfg.get(self.META) or {})
                current = meta.get("items", {}).get(key)
                if current and current.get("revision") == revision and cfg.get(key) == value:
                    del meta["items"][key]
                    self.save_config({self.META: meta})
        with self.lock:
            pending = (self.read_config().get(self.META) or {}).get("items", {})
            remains = any(key in pending for key in selected)
        return not remains, note or ("内容已有新版本，等待同步" if remains else "")


class WorkerClient:
    def __init__(self, read_config, opener):
        self.read_config = read_config
        self.opener = opener

    def _credentials(self):
        config = self.read_config()
        url = config.get("worker_admin_url") or ""
        token = config.get("worker_admin_token") or ""
        return url, token

    def ready(self):
        url, token = self._credentials()
        return bool(url and len(token) >= MIN_WORKER_ADMIN_TOKEN_LENGTH)

    def post(self, endpoint, payload, timeout=8, error_label="公网接口", *, expected_response=None):
        """向 Worker 发 POST，返回 ``(是否成功, 提示)``。"""
        url, token = self._credentials()
        if not url or not token:
            return False, "未配置公网同步地址（ai_local.json 的 worker_admin_url/token）"
        if len(token) < MIN_WORKER_ADMIN_TOKEN_LENGTH:
            return False, "公网管理令牌长度不足（至少 32 个字符）"
        try:
            request = urllib.request.Request(
                url.rstrip("/") + endpoint,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                method="POST",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + token,
                    "User-Agent": WORKER_UA,
                },
            )
            with self.opener.open(request, timeout=timeout) as response:
                result = json.loads(response.read().decode("utf-8"))
                if response.status == 200 and result.get("ok"):
                    if "sync_revision" in payload and (
                        type(result.get("sync_revision")) is not int
                        or result["sync_revision"] != payload["sync_revision"]
                    ):
                        return False, "%s未确认当前同步版本，已保留待同步，请检查公网接口版本" % error_label
                    if expected_response and any(
                        result.get(key) != value for key, value in expected_response.items()
                    ):
                        return False, "%s尚未确认新字段，已保留待同步，需更新公网接口" % error_label
                    return True, ""
                return False, "公网返回状态 %d" % response.status
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:160]
            return False, "%s返回 %d：%s" % (error_label, exc.code, detail)
        except Exception as exc:
            return False, "公网同步失败：%s" % exc

    def get_json(self, endpoint, timeout=8):
        """管理 GET，返回 ``(数据, 错误文案, 详情)``。"""
        url, token = self._credentials()
        if not url or not token:
            return None, "未配置公网地址（ai_local.json 的 worker_admin_url/token）", ""
        if len(token) < MIN_WORKER_ADMIN_TOKEN_LENGTH:
            return None, "公网管理令牌长度不足（至少 32 个字符）", ""
        request = urllib.request.Request(
            url.rstrip("/") + endpoint,
            headers={
                "Authorization": "Bearer " + token,
                "User-Agent": WORKER_UA,
            },
        )
        try:
            with self.opener.open(request, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8")), "", ""
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:300]
            return None, "公网访问记录接口返回 %d" % exc.code, detail
        except Exception as exc:
            return None, "访问记录获取失败：%s" % exc, ""


class LatestSensorSyncQueue:
    """按 ``(board, channel)`` 合并积压项，只发送每组的最新快照。"""

    def __init__(self, ready, sender):
        self.ready = ready
        self.sender = sender
        self._lock = threading.Lock()
        self._pending = {}
        self._newest = {}
        self._running = False

    def enqueue(self, rows):
        if not self.ready():
            return
        with self._lock:
            for row in rows:
                if row and row.get("channel"):
                    key = (row.get("board"), row.get("channel"))
                    try:
                        from datetime import datetime
                        stamp = datetime.fromisoformat(str(row.get("ts", "")).replace("Z", "+00:00")).timestamp()
                    except (ValueError, TypeError, OverflowError):
                        stamp = 0
                    if stamp < self._newest.get(key, 0):
                        continue
                    self._newest[key] = stamp
                    self._pending[key] = row
        self._start_if_pending()

    def _start_if_pending(self):
        with self._lock:
            if self._running or not self._pending:
                return
            self._running = True
        threading.Thread(
            target=self._run, name="sensor-sync", daemon=True,
        ).start()

    def _run(self):
        while True:
            with self._lock:
                batch = list(self._pending.values())
                self._pending.clear()
                if not batch:
                    self._running = False
                    return
            try:
                self.sender(batch)
            except Exception:
                # 尽力而为：同步异常不能终止本地采集；后续快照会再次入队。
                pass
