"""短文卡牌的保存、公开、归档与展示规则。"""

import re
import secrets
from contextlib import closing


BUILTIN_PROLOGUE_UID = "builtin-prologue-0001"


class EssayService:
    """独立于 HTTP 的短文服务；存储、配置和同步能力由调用方提供。"""

    def __init__(self, db, now_iso, read_config, save_config, sync_essays, sync_config):
        self.db = db
        self.now_iso = now_iso
        self.read_config = read_config
        self.save_config = save_config
        self.sync_essays = sync_essays
        self.sync_config = sync_config

    def public_catalog(self):
        with closing(self.db()) as con:
            rows = con.execute(
                """SELECT uid, created_at, updated_at, title, content, display_order
                   FROM essays WHERE status = 'public'
                   ORDER BY display_order ASC, updated_at DESC, id DESC LIMIT 100"""
            ).fetchall()
        return {"ok": True, "rows": [dict(row) for row in rows]}

    def admin_catalog(self):
        with closing(self.db()) as con:
            rows = con.execute(
                """SELECT uid, created_at, updated_at, title, content,
                          status, display_order, synced
                   FROM essays
                   ORDER BY CASE status WHEN 'public' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
                            display_order ASC, updated_at DESC, id DESC LIMIT 200"""
            ).fetchall()
        return {"ok": True, "rows": [dict(row) for row in rows],
                "featured_essay": self.read_config().get("featured_essay")}

    def featured_snapshot(self):
        essay = self.read_config().get("featured_essay")
        if essay:
            with closing(self.db()) as con:
                visible = con.execute(
                    "SELECT 1 FROM essays WHERE uid=? AND status='public'",
                    (essay.get("uid"),),
                ).fetchone()
            if not visible:
                essay = None
        return {"ok": True, "essay": essay}

    def feature_essay(self, data):
        with closing(self.db()) as con:
            row = con.execute(
                "SELECT uid, title, content, updated_at, status FROM essays WHERE uid=?",
                (str(data.get("uid") or ""),),
            ).fetchone()
        if row is None:
            return 404, {"ok": False, "error": "请先保存这张卡牌"}
        if row["status"] != "public":
            return 400, {"ok": False, "error": "请先将卡牌设为公开"}
        # 展示保留选中时的快照；编辑卡牌不会自动替换当前展示。
        essay = {key: row[key] for key in ("uid", "title", "content", "updated_at")}
        self.save_config({"featured_essay": essay})
        ok, note = self.sync_config({"featured_essay": essay})
        return 200, {"ok": True, "essay": essay,
                     "public_sync": ok, "public_sync_note": note}

    def save_essay(self, data):
        title = str(data.get("title") or "").strip()
        content = str(data.get("content") or "").strip()
        status = str(data.get("status") or "draft").strip()
        try:
            display_order = int(data.get("display_order", 100))
        except (TypeError, ValueError):
            return 400, {"error": "展示顺序必须是整数"}
        display_order = max(0, min(display_order, 9999))
        if not title or not content:
            return 400, {"error": "标题和正文都要填写"}
        if len(title) > 120 or len(content) > 12000:
            return 400, {"error": "标题或正文过长"}
        if status not in ("draft", "public", "archived"):
            return 400, {"error": "短文状态不正确"}
        edit_uid = str(data.get("uid") or "").strip()
        if edit_uid and not re.match(r"^[a-zA-Z0-9_-]{16,80}$", edit_uid):
            return 400, {"ok": False, "error": "invalid uid"}
        featured = self.read_config().get("featured_essay")
        featured_uid = (featured or {}).get("uid", BUILTIN_PROLOGUE_UID)
        if edit_uid == featured_uid and (status == "archived" or (
                featured and status != "public")):
            return 409, {"ok": False, "error": "请先展示另一张卡牌，再归档当前文章"}

        updated_at = self.now_iso()
        with closing(self.db()) as con:
            # 原序章第一次保存时入库，后续编辑继续使用同一 UID。
            if edit_uid == BUILTIN_PROLOGUE_UID:
                con.execute(
                    """INSERT OR IGNORE INTO essays(
                           uid, created_at, updated_at, title, content, status, display_order, synced
                       ) VALUES(?,?,?,?,?,?,?,0)""",
                    (edit_uid, updated_at, updated_at, title, content, status, display_order),
                )
            if edit_uid:
                cur = con.execute(
                    """UPDATE essays SET updated_at=?, title=?, content=?, status=?,
                           display_order=?, synced=0, sync_revision=sync_revision+1 WHERE uid=?""",
                    (updated_at, title, content, status, display_order, edit_uid),
                )
                con.commit()
                if cur.rowcount == 0:
                    return 404, {"ok": False, "error": "要编辑的短文不存在"}
                uid_value = edit_uid
                updated = True
            else:
                uid_value = secrets.token_hex(16)
                con.execute(
                    """INSERT INTO essays(
                           uid, created_at, updated_at, title, content,
                           status, display_order, synced
                       ) VALUES(?,?,?,?,?,?,?,0)""",
                    (uid_value, updated_at, updated_at, title, content, status, display_order),
                )
                con.commit()
                updated = False

        _, sync_note = self.sync_essays()
        with closing(self.db()) as con:
            saved = dict(con.execute(
                """SELECT uid, created_at, updated_at, title, content,
                          status, display_order, synced FROM essays WHERE uid=?""",
                (uid_value,),
            ).fetchone())
        return 200 if updated else 201, {
            "ok": True, "updated": updated, "essay": saved,
            "public_sync": bool(saved["synced"]), "public_sync_note": sync_note,
        }
