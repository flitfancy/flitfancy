"""Private model-chat sessions; AstrBot remains the owner of Firefly history."""
import json
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone

from flitfancy_openai import OpenAIError

PROFILE = re.compile(r"^[0-9a-f]{16}$")
MAX_CONTEXT_UNITS = 39000
MAX_CONTEXT_BYTES = 50000
MAX_HISTORY_TURNS = 9


class ModelHistoryError(Exception):
    def __init__(self, message, status=400, code="history_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def _uuid(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise ModelHistoryError("会话或请求编号无效。", 400, "invalid_id") from None
    return value


def _units(text):
    try:
        return len(text.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        raise ModelHistoryError("消息包含无效字符。", 400, "invalid_text") from None


def _clip_units(text, limit):
    if _units(text) <= limit:
        return text
    result, used = [], 0
    for char in text:
        width = 2 if ord(char) > 0xffff else 1
        if used + width > limit:
            break
        result.append(char)
        used += width
    return "".join(result)


def _json_bytes(text):
    # Quotes, backslashes and control characters grow when encoded as JSON.
    return len(json.dumps(text, ensure_ascii=False).encode("utf-8"))


def _now():
    return datetime.now(timezone.utc).isoformat()


class ModelHistoryService:
    def __init__(self, db, read_config, call_model):
        self.db = db
        self.read_config = read_config
        self.call_model = call_model
        self._ready = False
        self._init_lock = threading.Lock()

    def _connect(self):
        connection = self.db()
        connection.row_factory = sqlite3.Row
        return connection

    def _ensure(self):
        with self._init_lock:
            if self._ready:
                return
            connection = self._connect()
            try:
                connection.execute("BEGIN IMMEDIATE")
                connection.execute("""CREATE TABLE IF NOT EXISTS model_conversations (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, profile_id TEXT NOT NULL,
                    provider_label TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                )""")
                connection.execute("""CREATE TABLE IF NOT EXISTS model_conversation_turns (
                    seq INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
                    request_id TEXT UNIQUE NOT NULL, text TEXT NOT NULL, reply TEXT NOT NULL,
                    status TEXT NOT NULL, error TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    FOREIGN KEY(conversation_id) REFERENCES model_conversations(id)
                )""")
                connection.execute("CREATE INDEX IF NOT EXISTS model_turns_conversation ON model_conversation_turns(conversation_id, seq)")
                connection.execute("UPDATE model_conversation_turns SET status = 'interrupted', error = ?, updated_at = ? WHERE status = 'pending'",
                                   ("服务重启，本轮结果未知，请确认后再重试。", _now()))
                connection.commit()
                self._ready = True
            except Exception:
                connection.rollback()
                raise
            finally:
                connection.close()

    def create_conversation(self, conversation_id=None):
        self._ensure()
        identifier = _uuid(conversation_id) if conversation_id is not None else str(uuid.uuid4())
        stamp = _now()
        connection = self._connect()
        try:
            connection.execute("INSERT OR IGNORE INTO model_conversations VALUES (?, ?, '', '', '', ?, ?)",
                               (identifier, "新对话", stamp, stamp))
            connection.commit()
            return dict(connection.execute("SELECT * FROM model_conversations WHERE id = ?", (identifier,)).fetchone())
        finally:
            connection.close()

    def list_conversations(self, offset=0, limit=50):
        self._ensure()
        if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
            raise ModelHistoryError("历史列表参数无效。")
        connection = self._connect()
        try:
            rows = connection.execute("SELECT * FROM model_conversations ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?",
                                      (limit + 1, offset)).fetchall()
            return {"conversations": [dict(row) for row in rows[:limit]], "has_more": len(rows) > limit,
                    "next_offset": offset + limit if len(rows) > limit else None}
        finally:
            connection.close()

    def get_conversation(self, conversation_id, before=None, limit=50):
        self._ensure()
        identifier = _uuid(conversation_id)
        if (before is not None and (type(before) is not int or before < 1)) or type(limit) is not int or not 1 <= limit <= 100:
            raise ModelHistoryError("历史消息参数无效。")
        connection = self._connect()
        try:
            session = connection.execute("SELECT * FROM model_conversations WHERE id = ?", (identifier,)).fetchone()
            if session is None:
                raise ModelHistoryError("未找到该对话。", 404, "not_found")
            sql = "SELECT * FROM model_conversation_turns WHERE conversation_id = ?"
            args = [identifier]
            if before is not None:
                sql += " AND seq < ?"
                args.append(before)
            rows = connection.execute(sql + " ORDER BY seq DESC LIMIT ?", (*args, limit + 1)).fetchall()
            page = list(reversed(rows[:limit]))
            return {"conversation": dict(session), "turns": [dict(row) for row in page], "has_more": len(rows) > limit,
                    "next_before": page[0]["seq"] if len(rows) > limit and page else None}
        finally:
            connection.close()

    def begin_turn(self, conversation_id, request_id, text, profile_id):
        self._ensure()
        identifier, request_id = _uuid(conversation_id), _uuid(request_id)
        if not isinstance(text, str) or not text.strip() or _units(text.strip()) > 4000:
            raise ModelHistoryError("消息长度需为 1–4000 字。", 400, "invalid_text")
        if not isinstance(profile_id, str) or not PROFILE.fullmatch(profile_id):
            raise ModelHistoryError("模型配置已改变，请重新选择。", 409, "profile_changed")
        text = text.strip()
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            session = connection.execute("SELECT * FROM model_conversations WHERE id = ?", (identifier,)).fetchone()
            if session is None:
                raise ModelHistoryError("未找到该对话。", 404, "not_found")
            existing = connection.execute("SELECT * FROM model_conversation_turns WHERE request_id = ?", (request_id,)).fetchone()
            if existing is not None:
                if existing["conversation_id"] != identifier or existing["text"] != text or session["profile_id"] != profile_id:
                    raise ModelHistoryError("请求编号已用于其他消息。", 409, "request_conflict")
                connection.commit()
                return {"created": False, "turn": dict(existing)}
            if session["profile_id"] and session["profile_id"] != profile_id:
                raise ModelHistoryError("当前模型与此会话不同，请切回原模型或新建对话。", 409, "profile_changed")
            pending = connection.execute("SELECT 1 FROM model_conversation_turns WHERE conversation_id = ? AND status = 'pending' LIMIT 1",
                                         (identifier,)).fetchone()
            if pending:
                raise ModelHistoryError("请等待当前回复完成。", 409, "busy")
            rows = connection.execute("SELECT text, reply FROM model_conversation_turns WHERE conversation_id = ? AND status = 'complete' ORDER BY seq DESC LIMIT ?",
                                      (identifier, MAX_HISTORY_TURNS)).fetchall()
            selected, used, used_bytes = [], _units(text), _json_bytes(text)
            for row in rows:
                question, answer = row["text"], _clip_units(row["reply"], 12000)
                size = _units(question) + _units(answer)
                byte_size = _json_bytes(question) + _json_bytes(answer)
                if used + size > MAX_CONTEXT_UNITS or used_bytes + byte_size > MAX_CONTEXT_BYTES:
                    break
                selected.append((question, answer))
                used += size
                used_bytes += byte_size
            messages = []
            for question, answer in reversed(selected):
                messages.extend(({"role": "user", "content": question}, {"role": "assistant", "content": answer}))
            messages.append({"role": "user", "content": text})
            stamp = _now()
            title = " ".join(text.split())[:40] if not session["profile_id"] else session["title"]
            connection.execute("UPDATE model_conversations SET title = ?, profile_id = ?, updated_at = ? WHERE id = ?",
                               (title, profile_id, stamp, identifier))
            connection.execute("INSERT INTO model_conversation_turns(conversation_id, request_id, text, reply, status, error, created_at, updated_at) VALUES (?, ?, ?, '', 'pending', '', ?, ?)",
                               (identifier, request_id, text, stamp, stamp))
            turn = dict(connection.execute("SELECT * FROM model_conversation_turns WHERE request_id = ?", (request_id,)).fetchone())
            connection.commit()
            return {"created": True, "turn": turn, "messages": messages}
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _finish(self, request_id, status, reply="", error="", model="", provider_label=""):
        connection = self._connect()
        try:
            connection.execute("BEGIN IMMEDIATE")
            stamp = _now()
            connection.execute("UPDATE model_conversation_turns SET status = ?, reply = ?, error = ?, updated_at = ? WHERE request_id = ? AND status = 'pending'",
                               (status, reply, error[:240], stamp, request_id))
            row = connection.execute("SELECT * FROM model_conversation_turns WHERE request_id = ?", (request_id,)).fetchone()
            if row is None:
                raise ModelHistoryError("对话记录暂不可用。", 503, "history_unavailable")
            if row["status"] == status and status == "complete":
                connection.execute("UPDATE model_conversations SET model = ?, provider_label = ?, updated_at = ? WHERE id = ?",
                                   (str(model)[:160], str(provider_label)[:60], stamp, row["conversation_id"]))
            else:
                connection.execute("UPDATE model_conversations SET updated_at = ? WHERE id = ?", (stamp, row["conversation_id"]))
            connection.commit()
            return dict(row)
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def send(self, conversation_id, request_id, text, profile_id):
        begun = self.begin_turn(conversation_id, request_id, text, profile_id)
        if not begun["created"]:
            return {"state": begun["turn"]["status"], "turn": begun["turn"], "replayed": True}
        try:
            result = self.call_model(begun["messages"], self.read_config(), profile_id=profile_id)
            reply = result.get("reply")
            if not isinstance(reply, str) or not reply.strip():
                raise OpenAIError("模型没有返回文字。", 502, "empty_response")
        except OpenAIError as error:
            self._finish(request_id, "failed", error=str(error))
            raise
        except Exception:
            self._finish(request_id, "failed", error="模型服务暂不可用。")
            raise ModelHistoryError("模型服务暂不可用。", 502, "model_unavailable") from None
        try:
            turn = self._finish(request_id, "complete", reply=reply,
                                model=result.get("model", ""), provider_label=result.get("provider_label", ""))
        except sqlite3.Error:
            return {"state": "unsaved", "reply": reply, "error": "模型已回复，但历史记录保存失败；请先复制答复。"}
        return {"state": turn["status"], "turn": turn, "replayed": False}
