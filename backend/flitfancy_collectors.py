"""Paired mobile collectors: scoped credentials, durable receipts and raw archives."""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone

from flitfancy_sensors import SENSOR_CSV_FIELDS, SENSOR_TEXT_FIELDS, normalize_sensor_row


class CollectorError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class CollectorService:
    def __init__(self, db, ingest, raw_dir, clock=time.time):
        self.db = db
        self.ingest = ingest
        self.raw_dir = Path(raw_dir)
        self.clock = clock
        self.lock = threading.RLock()
        self.failed_claims = {}
        self.ready = False

    def _ensure(self):
        with self.lock:
            if self.ready:
                return
            con = self.db()
            try:
                con.executescript("""
                    CREATE TABLE IF NOT EXISTS collector_devices(
                      uid TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL,
                      created_at REAL NOT NULL, last_seen REAL, revoked_at REAL);
                    CREATE TABLE IF NOT EXISTS collector_pairings(
                      code_hash TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT NOT NULL,
                      expires_at REAL NOT NULL);
                    CREATE TABLE IF NOT EXISTS collector_receipts(
                      uid TEXT NOT NULL, event_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
                      received_at REAL NOT NULL, PRIMARY KEY(uid,event_id));
                    CREATE INDEX IF NOT EXISTS idx_collector_receipts_time ON collector_receipts(received_at);
                """)
                con.commit()
                self.ready = True
            finally:
                con.close()

    @staticmethod
    def _hash(text):
        return hashlib.sha256(text.encode()).hexdigest()

    @staticmethod
    def _name(value):
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= 40 or any(ord(c) < 32 for c in value):
            raise CollectorError("设备名称需为 1–40 个字符")
        return value.strip()

    def list_devices(self):
        self._ensure()
        con = self.db()
        try:
            rows = con.execute("SELECT uid,name,created_at,last_seen,revoked_at FROM collector_devices ORDER BY created_at DESC").fetchall()
            return {"ok": True, "devices": [dict(row) for row in rows]}
        finally:
            con.close()

    def create_pairing(self, body):
        self._ensure()
        name = self._name(body.get("name"))
        requested = body.get("device_id")
        with self.lock:
            con = self.db()
            try:
                if requested and not con.execute("SELECT 1 FROM collector_devices WHERE uid=?", (requested,)).fetchone():
                    raise CollectorError("设备不存在", 404)
                uid = requested or uuid.uuid4().hex
                code = secrets.token_hex(6).upper()
                expires = self.clock() + 600
                con.execute("DELETE FROM collector_pairings WHERE expires_at < ? OR uid=?", (self.clock(), uid))
                con.execute("INSERT INTO collector_pairings VALUES(?,?,?,?)", (self._hash(code), uid, name, expires))
                con.commit()
                return {"ok": True, "pairing_code": code, "expires_at": expires, "device_id": uid, "name": name}
            finally:
                con.close()

    def claim(self, body, peer):
        self._ensure()
        now = self.clock()
        code = str(body.get("pairing_code", "")).replace("-", "").replace(" ", "").upper()
        with self.lock:
            failures = [stamp for stamp in self.failed_claims.get(peer, []) if stamp > now - 60]
            if len(failures) >= 5:
                raise CollectorError("配对尝试过多，请一分钟后重试", 429)
            # Bound the in-memory limiter even under changing remote addresses.
            if len(self.failed_claims) > 2048:
                self.failed_claims = {ip: stamps for ip, stamps in self.failed_claims.items() if stamps and stamps[-1] > now - 60}
            con = self.db()
            try:
                con.execute("BEGIN IMMEDIATE")
                pairing = con.execute("SELECT * FROM collector_pairings WHERE code_hash=? AND expires_at>=?", (self._hash(code), now)).fetchone()
                if not re.fullmatch(r"[A-F0-9]{12}", code) or not pairing:
                    self.failed_claims[peer] = failures + [now]
                    raise CollectorError("配对码无效、已使用或已过期", 401)
                token = pairing["uid"] + "." + secrets.token_urlsafe(32)
                con.execute("""INSERT INTO collector_devices(uid,name,token_hash,created_at) VALUES(?,?,?,?)
                               ON CONFLICT(uid) DO UPDATE SET name=excluded.name,token_hash=excluded.token_hash,revoked_at=NULL""",
                            (pairing["uid"], pairing["name"], self._hash(token), now))
                con.execute("DELETE FROM collector_pairings WHERE code_hash=?", (self._hash(code),))
                con.commit()
                self.failed_claims.pop(peer, None)
                return {"ok": True, "device_id": pairing["uid"], "name": pairing["name"], "collector_token": token,
                        "protocol": 1, "upload_path": "/api/collectors/ingest"}
            finally:
                con.close()

    def authenticate(self, authorization):
        self._ensure()
        token = authorization[7:] if authorization.startswith("Bearer ") else ""
        if not re.fullmatch(r"[a-f0-9]{32}\.[A-Za-z0-9_-]{40,60}", token):
            raise CollectorError("采集设备需要重新配对", 401)
        con = self.db()
        try:
            row = con.execute("SELECT uid,name,token_hash FROM collector_devices WHERE uid=? AND token_hash=? AND revoked_at IS NULL",
                              (token.split(".", 1)[0], self._hash(token))).fetchone()
            if not row:
                raise CollectorError("采集设备已停用或凭证无效", 401)
            return dict(row)
        finally:
            con.close()

    def revoke(self, body):
        self._ensure()
        con = self.db()
        try:
            result = con.execute("UPDATE collector_devices SET revoked_at=? WHERE uid=?", (self.clock(), body.get("device_id")))
            if not result.rowcount:
                raise CollectorError("设备不存在", 404)
            con.execute("DELETE FROM collector_pairings WHERE uid=?", (body.get("device_id"),))
            con.commit()
            return {"ok": True}
        finally:
            con.close()

    def _events(self, body):
        events = body.get("events")
        if type(body.get("protocol")) is not int or body.get("protocol") != 1 or not isinstance(events, list) or not 1 <= len(events) <= 100:
            raise CollectorError("protocol=1，events 需包含 1–100 条样本")
        result = []
        permitted = set(SENSOR_CSV_FIELDS) | {"ts", "channel", "board"}
        ids = set()
        for event in events:
            if not isinstance(event, dict) or not re.fullmatch(r"[a-f0-9]{64}", str(event.get("event_id", ""))):
                raise CollectorError("样本编号无效")
            event_id = event["event_id"]
            row = event.get("row")
            if event_id in ids or not isinstance(row, dict) or set(row) - permitted:
                raise CollectorError("样本重复或字段不受支持")
            ids.add(event_id)
            if not re.fullmatch(r"CH[0-6]", str(row.get("channel", ""))) or row.get("ok") not in (0, 1):
                raise CollectorError("采样通道或状态无效")
            if not isinstance(row.get("sensor"), str) or not 1 <= len(row["sensor"]) <= 80:
                raise CollectorError("传感器名称无效")
            if not isinstance(row.get("board"), str) or not 1 <= len(row["board"]) <= 80:
                raise CollectorError("感知板标识无效")
            try:
                stamp = datetime.fromisoformat(row["ts"].replace("Z", "+00:00"))
                if stamp.tzinfo is None or not self.clock() - 90 * 86400 <= stamp.timestamp() <= self.clock() + 600:
                    raise ValueError()
                for field in set(row) & set(SENSOR_CSV_FIELDS) - SENSOR_TEXT_FIELDS - {"sensor"}:
                    value = row[field]
                    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or abs(value) > 1e12):
                        raise ValueError()
                for field in SENSOR_TEXT_FIELDS & set(row):
                    if not isinstance(row[field], str) or len(row[field]) > 80:
                        raise ValueError()
                if "channel_index" in row and row["channel_index"] != int(row["channel"][2:]):
                    raise ValueError()
                if "uptime_ms" in row and (row["uptime_ms"] is None or not 0 <= row["uptime_ms"] <= 0xffffffff):
                    raise ValueError()
            except (KeyError, TypeError, ValueError, OverflowError):
                raise CollectorError("采样时间或数值无效") from None
            normalized = normalize_sensor_row(row)
            canonical = json.dumps(normalized, ensure_ascii=False, sort_keys=True, allow_nan=False)
            result.append((event_id, row, self._hash(canonical)))
        return result

    def ingest_batch(self, device, body):
        events = self._events(body)
        received = self.clock()
        saved_rows = []
        duplicates = 0
        with self.lock:
            con = self.db()
            try:
                con.execute("BEGIN IMMEDIATE")
                if not con.execute("SELECT 1 FROM collector_devices WHERE uid=? AND token_hash=? AND revoked_at IS NULL", (device["uid"], device["token_hash"])).fetchone():
                    raise CollectorError("采集设备已停用", 401)
                fresh = []
                for event_id, row, payload_hash in events:
                    receipt = con.execute("SELECT payload_hash FROM collector_receipts WHERE uid=? AND event_id=?", (device["uid"], event_id)).fetchone()
                    if receipt:
                        if receipt[0] != payload_hash:
                            raise CollectorError("已接收样本的内容不能更改", 409)
                        duplicates += 1
                    else:
                        fresh.append((event_id, row, payload_hash))
                raw = []
                for event_id, row, payload_hash in fresh:
                    tagged = {**row, "collector_id": device["uid"], "collector_name": device["name"], "collector_type": "android"}
                    saved = self.ingest(tagged, con=con)
                    if saved is None:
                        raise CollectorError("无法保存采样数据")
                    saved_rows.append(saved)
                    con.execute("INSERT INTO collector_receipts VALUES(?,?,?,?)", (device["uid"], event_id, payload_hash, received))
                    raw.append({"device_id": device["uid"], "event_id": event_id, "received_at": received, "row": tagged})
                if raw:
                    month = datetime.fromtimestamp(received, timezone.utc).strftime("%Y-%m")
                    directory = self.raw_dir / month
                    directory.mkdir(parents=True, exist_ok=True)
                    # A retry after a database commit failure may repeat raw lines; stable
                    # event IDs make those identifiable. Never ACK before archive fsync.
                    with (directory / (device["uid"] + ".jsonl")).open("a", encoding="utf-8", newline="\n") as archive:
                        for event in raw:
                            archive.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
                        archive.flush()
                        os.fsync(archive.fileno())
                con.execute("UPDATE collector_devices SET last_seen=? WHERE uid=?", (received, device["uid"]))
                con.execute("DELETE FROM collector_receipts WHERE received_at < ?", (received - 91 * 86400,))
                con.commit()
                return {"ok": True, "accepted": len(fresh), "duplicates": duplicates,
                        "acknowledged": [event[0] for event in events]}, saved_rows
            except Exception:
                con.rollback()
                raise
            finally:
                con.close()
