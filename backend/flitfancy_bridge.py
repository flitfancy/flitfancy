"""全界之桥的 NAS 连接边界：连接测试、文件传输和任务状态。"""
from __future__ import annotations

import errno
import ipaddress
import re
import stat
from contextlib import contextmanager
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import threading
import time
from uuid import uuid4

TEMP_PREFIX = ".bridge-part-"
LAN_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


class BridgeError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def relative_path(value, *, empty=True, internal=False):
    """Only canonical, relative paths; reject Windows aliases, ADS and UNC paths."""
    if not isinstance(value, str) or len(value) > 2048:
        raise BridgeError("路径无效")
    if value == "" and empty:
        return ""
    parts = value.split("/")
    for part in parts:
        try:
            units = len(part.encode("utf-16-le"))
        except UnicodeEncodeError:
            raise BridgeError("路径无效") from None
        if (not part or part in (".", "..") or part[-1:] in (" ", ".")
                or units > 510
                or re.search(r'[\\:*?"<>|\x00-\x1f\x7f]', part)
                or re.match(r"^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", part, re.I)
                or (not internal and part.lower().startswith(TEMP_PREFIX))):
            raise BridgeError("路径或文件名不可用")
    return value


def checked_settings(data, previous=None):
    previous = previous or {}
    host = str(data.get("host") or "").strip()
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        raise BridgeError("请输入 NAS 的局域网 IPv4 地址") from None
    if not any(address in network for network in LAN_NETWORKS):
        raise BridgeError("NAS 地址必须位于局域网私有网段")
    share = relative_path(str(data.get("share") or ""), empty=False)
    if "/" in share:
        raise BridgeError("共享名不能包含目录")
    root = relative_path(str(data.get("root") or "bridge/inbox"))
    user = str(data.get("user") or "").strip()
    if not user or len(user) > 256 or any(ord(c) < 32 for c in user):
        raise BridgeError("请填写共享账号")
    password = data.get("password")
    if not password and all(previous.get(k) == v for k, v in (("host", host), ("share", share), ("user", user))):
        password = previous.get("password")
    if not isinstance(password, str) or not password or len(password) > 1024 or "\x00" in password:
        raise BridgeError("请填写共享密码；更换地址或账号后需重新填写")
    return {"host": host, "share": share, "user": user, "password": password, "root": root}


def is_link(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


@contextmanager
def storage_errors():
    try:
        yield
    except BridgeError:
        raise
    except OSError as error:
        messages = {
            errno.ENOENT: ("文件或目录不存在", 404),
            errno.EEXIST: ("同名文件或目录已存在，请更换名称", 409),
            errno.ENOTEMPTY: ("只能删除空目录，请先处理其中的文件", 409),
            errno.ENOSPC: ("NAS 可用空间不足", 507),
            errno.EACCES: ("共享账号没有此操作权限", 403),
            errno.EPERM: ("共享账号没有此操作权限", 403),
        }
        message, status = messages.get(error.errno, ("NAS 连接或文件操作失败，请检查连接设置后重试", 503))
        raise BridgeError(message, status) from None
    except Exception:
        # SMB exceptions may include remote paths or authentication details.
        raise BridgeError("NAS 连接或文件操作失败，请检查连接设置后重试", 503) from None


class SMBStorage:
    """SMB2/3 client with its own connection pool; never uses mapped drives."""
    def __init__(self, settings):
        try:
            import smbclient
        except ImportError:
            raise BridgeError("尚未安装 NAS 支持，请安装 backend/requirements-bridge.txt", 503) from None
        self.client = smbclient
        self.client.ClientConfig(skip_dfs=True)
        self.base = "\\\\" + settings["host"] + "\\" + settings["share"]
        self.root = settings["root"]
        self.options = {"username": settings["user"], "password": settings["password"],
                        "connection_timeout": 5, "connection_cache": {}, "require_signing": True}

    def _path(self, path, *, missing=False, with_info=False):
        relative_path(path, internal=True)
        all_parts = [p for p in (self.root + "/" + path).split("/") if p]
        current = self.base
        if not all_parts:
            info = self.client.stat(current, follow_symlinks=False, **self.options)
            if is_link(info) or not stat.S_ISDIR(info.st_mode):
                raise BridgeError("共享根目录不可用", 403)
        for index, part in enumerate(all_parts):
            current += "\\" + part
            try:
                info = self.client.stat(current, follow_symlinks=False, **self.options)
            except OSError as error:
                if missing and index == len(all_parts) - 1 and error.errno == errno.ENOENT:
                    return current
                raise
            if is_link(info):
                raise BridgeError("桥不访问符号链接或重解析目录", 403)
            if index < len(all_parts) - 1 and not stat.S_ISDIR(info.st_mode):
                raise BridgeError("父路径不是目录")
        return (current, info) if with_info else current

    def stat(self, path):
        return self._path(path, with_info=True)[1]

    def mkdir(self, path):
        self.client.mkdir(self._path(path, missing=True), **self.options)

    def open(self, path, mode):
        from smbprotocol.open import CreateOptions
        return self.client.open_file(self._path(path, missing="x" in mode), mode,
                                     create_options=CreateOptions.FILE_OPEN_REPARSE_POINT,
                                     share_access="r", **self.options)

    def rename(self, src, dst):
        self.client.rename(self._path(src), self._path(dst, missing=True), **self.options)

    def remove(self, path):
        self.client.remove(self._path(path), **self.options)

    def ensure_root(self):
        current = self.base
        for part in self.root.split("/"):
            if not part:
                continue
            current += "\\" + part
            try:
                info = self.client.stat(current, follow_symlinks=False, **self.options)
            except OSError as error:
                if error.errno != errno.ENOENT:
                    raise
                self.client.mkdir(current, **self.options)
                info = self.client.stat(current, follow_symlinks=False, **self.options)
            if is_link(info) or not stat.S_ISDIR(info.st_mode):
                raise BridgeError("桥接目录不可用：不能使用链接或普通文件", 403)

    def close(self):
        self.client.reset_connection_cache(connection_cache=self.options["connection_cache"])


CHUNK_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024
TASK_TTL = 3600
ACTIVE = {"receiving", "queued", "sending", "verifying", "testing"}


def file_digest(handle):
    digest = hashlib.sha256()
    size = 0
    while block := handle.read(CHUNK_BYTES):
        digest.update(block)
        size += len(block)
    return digest.hexdigest(), size


class BridgeService:
    """One transfer at a time; durable status, bounded chunks, no browser dependency after commit."""
    def __init__(self, read_config, save_config, state_dir, storage_factory=SMBStorage, clock=time.time):
        self.read_config, self.save_config = read_config, save_config
        self.root = Path(state_dir)
        self.storage_factory, self.clock = storage_factory, clock
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.tasks = {}
        self.lease = None
        self.thread = None
        self.storage = None
        self.storage_key = None
        self.storage_used = 0

    def _close_storage(self):
        storage, self.storage = self.storage, None
        self.storage_key = None
        if storage is not None:
            try:
                storage.close()
            except Exception:
                pass

    def _storage(self, settings):
        # Only the single worker uses this session. Reconnect after errors, config
        # changes or an idle gap; never cache path validation across operations.
        key = (self.storage_factory, settings)
        if self.storage_key != key or time.monotonic() - self.storage_used > 60:
            self._close_storage()
        if self.storage is None:
            self.storage = self.storage_factory(settings)
            self.storage_key = (self.storage_factory, settings.copy())
        return self.storage

    def _initialize(self):
        if self.lease is not None:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        handle = (self.root / "service.lock").open("a+b")
        try:
            handle.seek(0, 2)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            handle.close()
            raise BridgeError("桥接服务正被另一个进程使用", 409) from None
        try:
            path = self.root / "tasks.json"
            if path.exists():
                saved = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(saved, dict):
                    raise ValueError()
                self.tasks = {key: value for key, value in saved.items()
                              if re.fullmatch(r"[a-f0-9]{32}", key) and isinstance(value, dict)}
            for task in self.tasks.values():
                if task["state"] in ACTIVE or task.get("retryable"):
                    task.update(state="failed", error="服务重启中断了任务，请重新提交文件", retryable=False,
                                updated_at=self.clock())
            # Only remove our known staging files. No source/NAS data is deleted here.
            for path in self.root.glob("*.part"):
                if re.fullmatch(r"[a-f0-9]{32}\.part", path.name):
                    path.unlink()
            self._save()
        except Exception:
            handle.close()
            raise BridgeError("桥接任务状态无法读取或保存", 503) from None
        self.lease = handle

    def close(self):
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=30)
            if self.thread.is_alive():
                raise RuntimeError("bridge worker still running")
        with self.lock:
            self._close_storage()
            if self.lease is not None:
                self.lease.close()
                self.lease = None

    def _save(self):
        temp = self.root / "tasks.json.tmp"
        temp.write_text(json.dumps(self.tasks, ensure_ascii=False), encoding="utf-8")
        os.replace(temp, self.root / "tasks.json")

    def _settings(self):
        settings = self.read_config().get("nas_bridge")
        if not isinstance(settings, dict):
            raise BridgeError("请先配置 NAS 桥接通道", 409)
        return checked_settings(settings)

    def config(self):
        try:
            settings = self._settings()
        except BridgeError:
            return {"configured": False, "chunk_bytes": CHUNK_BYTES, "max_file_bytes": MAX_FILE_BYTES, "folder_upload": True, "task_wait": True}
        return {**{key: value for key, value in settings.items() if key != "password"},
                "configured": True, "password_saved": True,
                "chunk_bytes": CHUNK_BYTES, "max_file_bytes": MAX_FILE_BYTES, "folder_upload": True, "task_wait": True}

    def _reap(self):
        for task in self.tasks.values():
            if (task["state"] == "receiving" or task.get("retryable")) and self.clock() - task["updated_at"] > TASK_TTL:
                self._part(task["id"]).unlink(missing_ok=True)
                task.update(state="expired", retryable=False, error="任务已超时，请重新提交文件")
        while len(self.tasks) >= 64:
            terminal = [task for task in self.tasks.values() if task["state"] not in ACTIVE and not task.get("retryable")]
            if not terminal:
                break
            oldest = min(terminal, key=lambda task: task["updated_at"])
            del self.tasks[oldest["id"]]

    def _idle(self):
        self._initialize()
        self._reap()
        if any(task["state"] in ACTIVE or task.get("retryable") for task in self.tasks.values()):
            raise BridgeError("已有传输任务，请完成、重试或取消后再操作", 409)

    def configure(self, data):
        with self.lock:
            self._idle()
            previous = self.read_config().get("nas_bridge")
            settings = checked_settings(data, previous if isinstance(previous, dict) else {})
            self.save_config({"nas_bridge": settings})
            self._close_storage()
            return self.config()

    def _task(self, task_id):
        self._initialize()
        self._reap()
        if not isinstance(task_id, str):
            raise BridgeError("任务 ID 无效")
        task = self.tasks.get(task_id)
        if task is None:
            raise BridgeError("任务不存在", 404)
        return task

    def status(self, task_id=None, wait_ms=0):
        if type(wait_ms) is not int or not 0 <= wait_ms <= 5000:
            raise BridgeError("等待时间须为 0 到 5000 毫秒")
        with self.lock:
            self._initialize()
            self._reap()
            if task_id is not None:
                task = self._task(task_id)
                if wait_ms:
                    self.changed.wait_for(lambda: task['state'] not in {'queued', 'sending', 'verifying', 'testing'}, wait_ms / 1000)
                return copy.deepcopy(task)
            return {"configured": self.config()["configured"],
                    "tasks": copy.deepcopy(sorted(self.tasks.values(), key=lambda task: task["created_at"], reverse=True))}

    def _part(self, task_id):
        return self.root / (task_id + ".part")

    def _new(self, kind, **values):
        task_id = uuid4().hex
        task = {"id": task_id, "kind": kind, "created_at": self.clock(), "updated_at": self.clock(),
                "received_bytes": 0, "sent_bytes": 0, "retryable": False, "error": None, **values}
        self.tasks[task_id] = task
        self._save()
        return task

    def begin(self, data):
        with self.lock:
            self._idle()
            self._settings()
            path = relative_path(data.get("path"), empty=False)
            size, sha = data.get("size"), data.get("sha256")
            if type(size) is not int or not 0 <= size <= MAX_FILE_BYTES:
                raise BridgeError("文件大小无效或超过 20 GiB 限制")
            if not isinstance(sha, str) or not re.fullmatch(r"[a-fA-F0-9]{64}", sha):
                raise BridgeError("请提供文件的 SHA-256")
            if shutil.disk_usage(self.root).free < size + 64 * 1024 * 1024:
                raise BridgeError("电脑暂存空间不足", 507)
            if type(data.get("reuse_identical", False)) is not bool:
                raise BridgeError("reuse_identical 必须为布尔值")
            folder_root = data.get("folder_root")
            if folder_root is not None:
                relative_path(folder_root, empty=False)
                if not path.startswith(folder_root + "/"):
                    raise BridgeError("文件路径不在指定文件夹内")
            task = self._new("transfer", state="receiving", path=path, size=size, sha256=sha.lower(),
                             reuse_identical=data.get("reuse_identical", False), folder_root=folder_root)
            try:
                self._part(task["id"]).touch(exist_ok=False)
            except OSError:
                task.update(state="failed", error="无法创建暂存文件")
                self._save()
                raise BridgeError("无法创建暂存文件", 503) from None
            return copy.deepcopy(task)

    def chunk(self, task_id, offset, length, stream):
        with self.lock:
            task = self._task(task_id)
            if task["state"] != "receiving" or offset != task["received_bytes"]:
                raise BridgeError("任务状态或分块偏移不符，请读取任务状态后重试", 409)
            if not 0 < length <= CHUNK_BYTES or offset + length > task["size"]:
                raise BridgeError("分块大小无效")
            # Read before appending: an interrupted HTTP request never commits a partial chunk.
            try:
                body = stream.read(length)
            except OSError:
                raise BridgeError("分块接收中断，可从当前偏移重试", 400) from None
            if len(body) != length:
                raise BridgeError("分块数据不完整，可从当前偏移重试")
            with self._part(task_id).open("r+b") as handle:
                handle.seek(offset)
                try:
                    handle.write(body)
                    handle.flush()
                    os.fsync(handle.fileno())
                except OSError:
                    handle.truncate(offset)
                    raise
            task.update(received_bytes=offset + length, updated_at=self.clock())
            self._save()
            return copy.deepcopy(task)

    def cancel(self, task_id):
        with self.lock:
            task = self._task(task_id)
            if task["state"] in {"queued", "sending", "verifying", "testing"}:
                raise BridgeError("NAS 操作已开始，等待任务完成后再操作", 409)
            self._part(task_id).unlink(missing_ok=True)
            if task["state"] != "succeeded":
                task.update(state="cancelled", retryable=False, updated_at=self.clock())
                self._save()
            return copy.deepcopy(task)

    def commit(self, task_id):
        with self.lock:
            task = self._task(task_id)
            if task["kind"] != "transfer":
                raise BridgeError("这不是文件传输任务", 409)
            if task["state"] in {"queued", "sending", "verifying", "succeeded"}:
                return copy.deepcopy(task)
            if not (task["state"] == "receiving" or task.get("retryable")) or task["received_bytes"] != task["size"]:
                raise BridgeError("文件尚未接收完整或任务不可重试", 409)
            settings = self._settings()
            task.update(state="queued", error=None, retryable=False, sent_bytes=0, updated_at=self.clock())
            task['attempts'] = task.get('attempts', 0) + 1
            self._launch(task, settings)
            return copy.deepcopy(task)

    def directories(self, data):
        with self.lock:
            self._idle()
            settings = self._settings()
            paths = data.get("paths")
            if not isinstance(paths, list) or not 1 <= len(paths) <= 10000:
                raise BridgeError("目录列表须包含 1 到 10000 项")
            paths = sorted(set(relative_path(path, empty=False) for path in paths),
                           key=lambda path: (path.count("/"), path))
            if sum(len(path.encode("utf-8")) for path in paths) > 900000:
                raise BridgeError("目录列表过大，请分批上传")
            task = self._new("directories", state="queued", size=0, paths=paths, directory_count=len(paths), completed_directories=0)
            self._launch(task, settings)
            return copy.deepcopy(task)

    def test_connection(self):
        with self.lock:
            self._idle()
            settings = self._settings()
            task = self._new("connection", state="testing", size=0)
            self._launch(task, settings)
            return copy.deepcopy(task)

    def _launch(self, task, settings):
        self._save()
        self.thread = threading.Thread(target=self._worker, args=(task["id"], settings), daemon=True, name="nas-bridge")
        try:
            self.thread.start()
        except Exception:
            task.update(state="failed", retryable=task["kind"] == "transfer", error="无法启动传输任务")
            self._save()
            raise BridgeError("无法启动传输任务", 503) from None

    def _update(self, task_id, **values):
        with self.lock:
            self.tasks[task_id].update(updated_at=self.clock(), **values)
            self._save()
            self.changed.notify_all()

    @staticmethod
    def _make_directories(storage, path, known):
        current = ""
        for part in filter(None, path.split("/")):
            current = current + "/" + part if current else part
            if current in known:
                continue
            try:
                info = storage.stat(current)
            except OSError as error:
                if error.errno != errno.ENOENT:
                    raise
                try:
                    storage.mkdir(current)
                except OSError as error:
                    if error.errno != errno.EEXIST:
                        raise
                info = storage.stat(current)
            if is_link(info) or not stat.S_ISDIR(info.st_mode):
                raise BridgeError("目标位置有同名文件，无法创建文件夹，请修改保存名称", 409)
            known.add(current)

    def _worker(self, task_id, settings):
        task = self.tasks[task_id]
        storage = None
        temporary = TEMP_PREFIX + task_id
        temporary_exists = False
        failure = None
        try:
            with storage_errors():
                if task["kind"] == "transfer":
                    with self._part(task_id).open("rb") as handle:
                        if file_digest(handle) != (task["sha256"], task["size"]):
                            raise BridgeError("接收文件的 SHA-256 校验失败，请取消后重新上传", 422)
                storage = self._storage(settings)
                storage.ensure_root()
                # The name is internal and unique to this task; remove a remnant of its failed attempt.
                if task.get('attempts', 0) > 1:
                    try:
                        storage.remove(temporary)
                    except OSError as error:
                        if error.errno != errno.ENOENT:
                            raise
                if task["kind"] == "connection":
                    probe = os.urandom(32)
                    temporary_exists = True
                    with storage.open(temporary, "xb") as handle:
                        handle.write(probe)
                    with storage.open(temporary, "rb") as handle:
                        if handle.read() != probe:
                            raise BridgeError("NAS 读写校验失败", 503)
                    storage.remove(temporary)
                    temporary_exists = False
                elif task["kind"] == "directories":
                    known = set()
                    for path in task["paths"]:
                        self._make_directories(storage, path, known)
                        self._update(task_id, completed_directories=task["completed_directories"] + 1)
                else:
                    self._make_directories(storage, task["path"].rpartition("/")[0], set())
                    try:
                        existing = storage.stat(task["path"])
                    except OSError as error:
                        if error.errno != errno.ENOENT:
                            raise
                    else:
                        if task.get("reuse_identical") and stat.S_ISREG(existing.st_mode) and existing.st_size == task["size"]:
                            self._update(task_id, state="verifying")
                            with storage.open(task["path"], "rb") as handle:
                                if file_digest(handle) == (task["sha256"], task["size"]):
                                    self._part(task_id).unlink(missing_ok=True)
                                    self._update(task_id, reused=True, sent_bytes=task["size"])
                                    return  # finally publishes success.
                        raise BridgeError("目标文件已存在且未允许复用或内容不同，请更换保存名称；桥不会覆盖原文件", 409)
                    self._update(task_id, state="sending")
                    temporary_exists = True
                    with self._part(task_id).open("rb") as reader, storage.open(temporary, "xb") as writer:
                        while block := reader.read(CHUNK_BYTES):
                            writer.write(block)
                            self._update(task_id, sent_bytes=task["sent_bytes"] + len(block))
                    self._update(task_id, state="verifying")
                    with storage.open(temporary, "rb") as handle:
                        if file_digest(handle) != (task["sha256"], task["size"]):
                            raise BridgeError("NAS 写入后的 SHA-256 校验失败", 503)
                    storage.rename(temporary, task["path"])
                    temporary_exists = False
                    self._part(task_id).unlink(missing_ok=True)
        except Exception as error:
            failure = error if isinstance(error, BridgeError) else BridgeError("桥接任务失败，请检查本地磁盘及 NAS 连接", 503)
        finally:
            if storage is not None:
                try:
                    if temporary_exists:
                        storage.remove(temporary)
                except OSError as error:
                    if error.errno != errno.ENOENT and failure is None:
                        failure = BridgeError("NAS 临时文件清理失败，请检查共享写入权限", 503)
                except Exception:
                    if failure is None:
                        failure = BridgeError("NAS 临时文件清理失败", 503)
                if failure is not None:
                    self._close_storage()
                else:
                    self.storage_used = time.monotonic()
            try:
                # The frontend owns the folder queue; terminal history needs counts, not thousands of paths.
                if task["kind"] == "directories":
                    with self.lock:
                        task.pop("paths", None)
                if failure is None:
                    self._update(task_id, state="succeeded", retryable=False, error=None)
                else:
                    self._update(task_id, state="failed", error=str(failure),
                                 retryable=task["kind"] == "transfer" and self._part(task_id).exists())
            except OSError:
                # Preserve in-memory failure and let restart recovery reject incomplete persisted work.
                with self.lock:
                    task.update(state="failed", error="任务结果无法保存，请检查电脑磁盘空间", retryable=False)
                    self.changed.notify_all()
