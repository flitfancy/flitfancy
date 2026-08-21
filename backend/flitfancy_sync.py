"""Worker 管理请求客户端与最新传感器快照同步队列。"""

import json
import threading
import urllib.error
import urllib.request


MIN_WORKER_ADMIN_TOKEN_LENGTH = 32
WORKER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)


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

    def post(self, endpoint, payload, timeout=8, error_label="公网接口"):
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
        self._running = False

    def enqueue(self, rows):
        if not self.ready():
            return
        with self._lock:
            for row in rows:
                if row and row.get("channel"):
                    key = (row.get("board"), row.get("channel"))
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
