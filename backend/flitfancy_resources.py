"""资源管理与发布：上传文件、维护 manifest、git 提交推送。

设计要点：
- manifest.json（docs/resources/manifest.json）是上传资源的唯一数据源，
  公网页面按栏目动态渲染卡片；
- 卡片 = 稳定 id，重复上传 = 追加版本（新版本插最前，默认展示最新）；
- 文件存 docs/resources/files/<id>/，历史版本文件保留；
- 发布 = git add docs/resources + commit + push（只允许这一组操作）；
- 上传走两段式：prepare（元数据 JSON，返回一次性 token）→
  upload（原始字节流，按 token 定位临时文件），由 HTTP 层流式写盘。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
import time

ALLOWED_EXTENSIONS = (".zip", ".gz", ".tgz", ".bin", ".pdf", ".3mf", ".stl",
                      ".step", ".stp", ".json", ".md", ".txt", ".tar")
GROUPS = ("firefly", "naturecraft", "flitfancy")
MAX_FILE_BYTES = 500 * 1024 * 1024
TOKEN_TTL_SECONDS = 900
MANIFEST_NAME = "manifest.json"
FILES_DIR = "files"


def sanitize_filename(name):
    """清洗文件名：只保留字母数字/点/横线/下划线，防路径穿越。"""
    s = str(name or "").strip()
    s = os.path.basename(s.replace("\\", "/"))
    s = re.sub(r"[^A-Za-z0-9._\-]+", "_", s).strip("._")
    return s[:120]


def _slugify(title):
    runs = re.findall(r"[A-Za-z0-9]+", str(title or ""))
    slug = "-".join(r.lower() for r in runs)[:40]
    return slug or ""


class ResourceService:
    """上传资源的落盘、manifest 维护与 git 发布。"""

    def __init__(self, docs_root, now_iso, log_line=None):
        self.docs_root = docs_root
        self.resources_root = os.path.join(docs_root, "resources")
        self.files_root = os.path.join(self.resources_root, FILES_DIR)
        self.manifest_path = os.path.join(self.resources_root, MANIFEST_NAME)
        self.repo_root = os.path.dirname(docs_root)
        self._now_iso = now_iso
        self._log_line = log_line
        self._lock = threading.Lock()
        self._publish_lock = threading.Lock()
        self._pending = {}   # token -> {"meta":…, "tmp":…, "expires":…}

    # ---------- manifest ----------
    def load_manifest(self):
        try:
            with open(self.manifest_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, ValueError):
            return []

    def _save_manifest(self, entries):
        os.makedirs(self.resources_root, exist_ok=True)
        tmp = self.manifest_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.manifest_path)

    def list_resources(self):
        with self._lock:
            entries = self.load_manifest()
        for entry in entries:
            for v in entry.get("versions", []):
                rel = v.get("file")
                if rel:
                    p = os.path.join(self.resources_root, rel.replace("/", os.sep))
                    v["exists"] = os.path.isfile(p)
        return entries

    # ---------- 上传两段式 ----------
    def begin_upload(self, meta):
        """校验元数据，登记一次性上传令牌，返回 token 与元信息。"""
        group = str(meta.get("group") or "").strip().lower()
        if group not in GROUPS:
            raise ValueError("未知栏目：group 必须是 " + "/".join(GROUPS))
        title = str(meta.get("title") or "").strip()[:120]
        res_id = str(meta.get("id") or "").strip()
        filename = sanitize_filename(meta.get("filename"))
        size = int(meta.get("size") or 0)
        if size < 0 or size > MAX_FILE_BYTES:
            raise ValueError("文件大小超出限制（最大 500MB）")
        if size > 0 and not filename:
            raise ValueError("上传文件时必须提供文件名")
        desc = str(meta.get("desc") or "").strip()[:400]
        details = str(meta.get("details") or "").strip()[:6000]
        label = str(meta.get("label") or "").strip()[:60]
        note = str(meta.get("note") or "").strip()[:400]

        with self._lock:
            entries = self.load_manifest()
            if res_id:
                card = next((e for e in entries if e.get("id") == res_id), None)
                if card is None:
                    raise ValueError("资源不存在：%s" % res_id)
                if group != card.get("group"):
                    raise ValueError("栏目与已有卡片不一致")
            else:
                if not title and not filename:
                    raise ValueError("新建资源至少需要标题或文件")
                slug = _slugify(title)
                if slug:
                    base = "res-" + slug
                    res_id = base
                    n = 2
                    while any(e.get("id") == res_id for e in entries):
                        res_id = base + "-" + str(n)
                        n += 1
                else:
                    res_id = "res-" + time.strftime("%Y%m%d-%H%M%S")
                if not title:
                    title = filename or ("资源 " + res_id)
            token = secrets.token_urlsafe(24)
            tmp = ""
            if size > 0:
                os.makedirs(self.files_root, exist_ok=True)
                fd, tmp = tempfile.mkstemp(prefix="up-", suffix=".bin")
                os.close(fd)
            self._pending[token] = {
                "meta": {"id": res_id, "group": group, "title": title,
                         "desc": desc, "details": details, "label": label,
                         "note": note, "filename": filename, "size": size},
                "tmp": tmp, "expires": time.time() + TOKEN_TTL_SECONDS,
            }
            for k in [k for k, v in self._pending.items() if v["expires"] < time.time()]:
                self.discard_pending(k)
            return {"token": token, "id": res_id, "group": group, "title": title}

    def upload_target(self, token):
        """返回一次性令牌对应的临时文件路径；纯文字版本返回 None。"""
        slot = self._pending.get(str(token or ""))
        if not slot or slot["expires"] < time.time():
            raise ValueError("上传令牌无效或已过期")
        return slot["tmp"] or None, slot["meta"]

    def finalize_upload(self, token):
        slot = self._pending.pop(str(token or ""), None)
        if not slot:
            raise ValueError("上传令牌无效或已过期")
        meta = slot["meta"]
        res_id = meta["id"]
        tmp = slot["tmp"]
        stamp = time.strftime("%Y%m%d-%H%M%S")
        with self._lock:
            entries = self.load_manifest()
            card = next((e for e in entries if e.get("id") == res_id), None)
            if card is None:
                # 新建卡片在 begin_upload 只登记了令牌、未持久化；
                # 这里按 pending 元数据补建，保证两段式上传对新建资源可用。
                card = {"id": res_id, "group": meta["group"], "title": meta["title"],
                        "desc": "", "details": "", "versions": []}
                entries.insert(0, card)
            version = {"date": self._now_iso(), "label": meta["label"],
                       "note": meta["note"], "file": None, "sha256": None,
                       "size": 0}
            if tmp and os.path.isfile(tmp) and os.path.getsize(tmp) > 0:
                os.makedirs(os.path.join(self.files_root, res_id), exist_ok=True)
                rel = FILES_DIR + "/" + res_id + "/" + stamp + "-" + meta["filename"]
                dst = os.path.join(self.resources_root, rel.replace("/", os.sep))
                shutil.move(tmp, dst)
                h = hashlib.sha256()
                with open(dst, "rb") as f:
                    for chunk in iter(lambda: f.read(1 << 20), b""):
                        h.update(chunk)
                version["file"] = rel
                version["sha256"] = h.hexdigest()
                version["size"] = os.path.getsize(dst)
            else:
                # 纯文字更新（无文件）：清理可能残留的空临时文件
                if tmp:
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
            card.setdefault("versions", []).insert(0, version)
            if meta["desc"]:
                card["desc"] = meta["desc"]
            if meta["details"]:
                card["details"] = meta["details"]
            self._save_manifest(entries)
        entry = dict(card)
        entry["latest"] = version
        return entry

    def discard_pending(self, token):
        """丢弃一次性上传令牌并清理其临时文件（传输不完整/取消时用）。"""
        slot = self._pending.pop(token, None)
        if slot and slot.get("tmp"):
            try:
                os.remove(slot["tmp"])
            except OSError:
                pass

    def delete_card(self, res_id):
        with self._lock:
            entries = self.load_manifest()
            card = next((e for e in entries if e.get("id") == res_id), None)
            if card is None:
                raise ValueError("资源不存在：%s" % res_id)
            removed = 0
            for v in card.get("versions", []):
                rel = v.get("file")
                if rel:
                    p = os.path.join(self.resources_root, rel.replace("/", os.sep))
                    if os.path.isfile(p):
                        os.remove(p)
                        removed += 1
            self._save_manifest([e for e in entries if e.get("id") != res_id])
            try:
                os.rmdir(os.path.join(self.files_root, res_id))  # 仅当目录为空时成功
            except OSError:
                pass
        return removed

    # ---------- 发布 ----------
    def _current_branch(self):
        r = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=self.repo_root, capture_output=True, text=True,
            timeout=30, encoding="utf-8", errors="replace",
        )
        branch = r.stdout.strip() if r.returncode == 0 else ""
        return branch or "main"

    def publish(self):
        def run(args, timeout=180):
            return subprocess.run(
                ["git"] + args, cwd=self.repo_root, capture_output=True,
                text=True, timeout=timeout, encoding="utf-8",
                errors="replace",
            )

        with self._publish_lock:
            added = run(["add", "docs/resources"])
            if added.returncode != 0:
                return False, "git add 失败：" + (added.stderr or "").strip()
            status = run(["status", "--porcelain", "docs/resources"])
            note_parts = []
            if status.stdout.strip():
                title = "resources: update via console"
                c = run(["commit", "-m", title])
                if c.returncode != 0:
                    return False, "git commit 失败：" + (c.stderr or "").strip()
                note_parts.append("本地已提交")
            else:
                note_parts.append("无新变更")
            push = run(["push", "origin", self._current_branch()], timeout=300)
            if push.returncode != 0:
                return False, ("推送失败（本地提交已保留，稍后重试发布即可）："
                               + (push.stderr or "").strip()[-200:])
            note_parts.append("已推送 GitHub，Pages 约 10 分钟生效")
        if self._log_line:
            self._log_line("resources published: " + "；".join(note_parts))
        return True, "；".join(note_parts)
