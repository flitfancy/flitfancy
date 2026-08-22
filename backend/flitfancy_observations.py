"""见闻星球与弦的纯验证、序列化规则。"""

import json
import re
import secrets
import urllib.parse
from datetime import date


OBSERVATION_CATEGORIES = (
    "宇宙与自然",
    "生命与感知",
    "技术与造物",
    "历史与文明",
    "语言与艺术",
    "思想与日常",
)
OBSERVATION_STATUSES = ("draft", "public", "archived")
UID_RE = re.compile(r"^[a-zA-Z0-9_-]{16,80}$")


def valid_uid(value):
    return bool(UID_RE.fullmatch(str(value or "").strip()))


def decode_tags(value):
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [str(tag) for tag in parsed if str(tag).strip()]


def observation_row(row):
    result = dict(row)
    result["tags"] = decode_tags(result.pop("tags_json", "[]"))
    return result


def _source_url_valid(value):
    if not value:
        return True
    try:
        parsed = urllib.parse.urlsplit(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def normalize_observation(data):
    title = str(data.get("title") or "").strip()
    category = str(data.get("category") or "").strip()
    summary = str(data.get("summary") or "").strip()
    content = str(data.get("content") or "").strip()
    discovered_at = str(data.get("discovered_at") or "").strip()
    source_name = str(data.get("source_name") or "").strip()
    source_url = str(data.get("source_url") or "").strip()
    status = str(data.get("status") or "draft").strip()
    raw_tags = data.get("tags")
    if not title or not summary:
        return None, "标题和短描述都要填写"
    if len(title) > 120 or len(summary) > 400 or len(content) > 12000:
        return None, "标题、短描述或正文过长"
    if category not in OBSERVATION_CATEGORIES:
        return None, "见闻分类不正确"
    if status not in OBSERVATION_STATUSES:
        return None, "见闻状态不正确"
    try:
        date.fromisoformat(discovered_at)
    except ValueError:
        return None, "发现时间必须是有效日期"
    if not isinstance(raw_tags, list):
        return None, "标签必须是数组"
    tags = []
    for raw in raw_tags:
        tag = str(raw or "").strip()
        if not tag or tag in tags:
            continue
        if len(tag) > 32:
            return None, "单个标签不能超过 32 字"
        tags.append(tag)
    if len(tags) > 12:
        return None, "一颗星球最多保存 12 个标签"
    if len(source_name) > 160 or len(source_url) > 1000:
        return None, "来源名称或链接过长"
    if not _source_url_valid(source_url):
        return None, "来源链接只允许 http 或 https"
    return {
        "title": title,
        "category": category,
        "tags": tags,
        "summary": summary,
        "content": content,
        "discovered_at": discovered_at,
        "source_name": source_name,
        "source_url": source_url,
        "status": status,
    }, None


def normalize_observation_link(data):
    source_uid = str(data.get("source_uid") or "").strip()
    target_uid = str(data.get("target_uid") or "").strip()
    relation = str(data.get("relation") or "").strip()
    if not valid_uid(source_uid) or not valid_uid(target_uid):
        return None, "弦的起点或目标星球不正确"
    if source_uid == target_uid:
        return None, "弦不能连接同一颗星球"
    if not relation or len(relation) > 80:
        return None, "关系词不能为空且不能超过 80 字"
    return {
        "source_uid": source_uid,
        "target_uid": target_uid,
        "relation": relation,
    }, None


class ObservationService:
    """见闻领域服务：HTTP 层只委托，不持有 SQL、验证或同步细节。"""

    def __init__(self, db, now_iso, sync_observations, sync_links):
        self.db = db
        self.now_iso = now_iso
        self.sync_observations = sync_observations
        self.sync_links = sync_links

    def public_catalog(self):
        con = self.db()
        rows = con.execute(
            """SELECT uid, created_at, updated_at, title, category, tags_json,
                      summary, content, discovered_at, source_name, source_url
               FROM observations WHERE status = 'public'
               ORDER BY discovered_at DESC, updated_at DESC, id DESC LIMIT 300"""
        ).fetchall()
        links = con.execute(
            """SELECT link.uid, link.created_at, link.updated_at, link.source_uid,
                      link.target_uid, link.relation
               FROM observation_links link
               JOIN observations source ON source.uid = link.source_uid
               JOIN observations target ON target.uid = link.target_uid
               WHERE source.status = 'public' AND target.status = 'public'
               ORDER BY link.updated_at DESC, link.id DESC LIMIT 600"""
        ).fetchall()
        con.close()
        return {
            "ok": True,
            "rows": [observation_row(row) for row in rows],
            "links": [dict(row) for row in links],
        }

    def admin_observations(self):
        con = self.db()
        rows = con.execute(
            """SELECT uid, created_at, updated_at, title, category, tags_json,
                      summary, content, discovered_at, source_name, source_url,
                      status, synced
               FROM observations
               ORDER BY CASE status WHEN 'public' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                        discovered_at DESC, updated_at DESC, id DESC LIMIT 500"""
        ).fetchall()
        con.close()
        return {"ok": True, "rows": [observation_row(row) for row in rows]}

    def admin_links(self):
        con = self.db()
        rows = con.execute(
            """SELECT uid, created_at, updated_at, source_uid, target_uid,
                      relation, synced
               FROM observation_links ORDER BY updated_at DESC, id DESC LIMIT 1000"""
        ).fetchall()
        con.close()
        return {"ok": True, "rows": [dict(row) for row in rows]}

    def save_observation(self, data):
        normalized, error = normalize_observation(data)
        if error:
            return 400, {"ok": False, "error": error}
        edit_uid = str(data.get("uid") or "").strip()
        if edit_uid and not valid_uid(edit_uid):
            return 400, {"ok": False, "error": "invalid uid"}
        updated_at = self.now_iso()
        tags_json = json.dumps(normalized["tags"], ensure_ascii=False, separators=(",", ":"))
        con = self.db()
        if edit_uid:
            cur = con.execute(
                """UPDATE observations SET updated_at=?, title=?, category=?, tags_json=?,
                          summary=?, content=?, discovered_at=?, source_name=?, source_url=?,
                          status=?, synced=0 WHERE uid=?""",
                (
                    updated_at, normalized["title"], normalized["category"], tags_json,
                    normalized["summary"], normalized["content"], normalized["discovered_at"],
                    normalized["source_name"], normalized["source_url"], normalized["status"],
                    edit_uid,
                ),
            )
            if cur.rowcount == 0:
                con.close()
                return 404, {"ok": False, "error": "要编辑的星球不存在"}
            uid_value = edit_uid
            updated = True
        else:
            uid_value = secrets.token_hex(16)
            con.execute(
                """INSERT INTO observations(
                       uid, created_at, updated_at, title, category, tags_json,
                       summary, content, discovered_at, source_name, source_url,
                       status, synced
                   ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)""",
                (
                    uid_value, updated_at, updated_at, normalized["title"],
                    normalized["category"], tags_json, normalized["summary"],
                    normalized["content"], normalized["discovered_at"],
                    normalized["source_name"], normalized["source_url"], normalized["status"],
                ),
            )
            updated = False
        con.execute(
            "UPDATE observation_links SET synced=0 WHERE source_uid=? OR target_uid=?",
            (uid_value, uid_value),
        )
        con.commit()
        con.close()
        _, sync_note = self.sync_observations()
        self.sync_links()
        con = self.db()
        saved = con.execute(
            """SELECT uid, created_at, updated_at, title, category, tags_json,
                      summary, content, discovered_at, source_name, source_url,
                      status, synced FROM observations WHERE uid=?""",
            (uid_value,),
        ).fetchone()
        con.close()
        saved = observation_row(saved)
        return 200 if updated else 201, {
            "ok": True,
            "updated": updated,
            "observation": saved,
            "public_sync": bool(saved["synced"]),
            "public_sync_note": sync_note,
        }

    def save_link(self, data):
        normalized, error = normalize_observation_link(data)
        if error:
            return 400, {"ok": False, "error": error}
        edit_uid = str(data.get("uid") or "").strip()
        if edit_uid and not valid_uid(edit_uid):
            return 400, {"ok": False, "error": "invalid uid"}
        con = self.db()
        endpoint_count = con.execute(
            "SELECT COUNT(*) FROM observations WHERE uid IN (?, ?)",
            (normalized["source_uid"], normalized["target_uid"]),
        ).fetchone()[0]
        if endpoint_count != 2:
            con.close()
            return 400, {"ok": False, "error": "弦的两端必须是已有星球"}
        updated_at = self.now_iso()
        if edit_uid:
            cur = con.execute(
                """UPDATE observation_links SET updated_at=?, source_uid=?, target_uid=?,
                          relation=?, synced=0 WHERE uid=?""",
                (
                    updated_at, normalized["source_uid"], normalized["target_uid"],
                    normalized["relation"], edit_uid,
                ),
            )
            if cur.rowcount == 0:
                con.close()
                return 404, {"ok": False, "error": "要编辑的弦不存在"}
            uid_value = edit_uid
            updated = True
        else:
            uid_value = secrets.token_hex(16)
            con.execute(
                """INSERT INTO observation_links(
                       uid, created_at, updated_at, source_uid, target_uid, relation, synced
                   ) VALUES(?,?,?,?,?,?,0)""",
                (
                    uid_value, updated_at, updated_at, normalized["source_uid"],
                    normalized["target_uid"], normalized["relation"],
                ),
            )
            updated = False
        con.commit()
        con.close()
        _, sync_note = self.sync_links()
        con = self.db()
        saved = con.execute(
            """SELECT uid, created_at, updated_at, source_uid, target_uid,
                      relation, synced FROM observation_links WHERE uid=?""",
            (uid_value,),
        ).fetchone()
        con.close()
        saved = dict(saved)
        return 200 if updated else 201, {
            "ok": True,
            "updated": updated,
            "link": saved,
            "public_sync": bool(saved["synced"]),
            "public_sync_note": sync_note,
        }
