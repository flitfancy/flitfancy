"""Private append-only record of Firefly's external model consultations."""

import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def default_path():
    explicit = os.environ.get("FLITFANCY_CONSULT_DB_PATH")
    if explicit:
        return Path(explicit)
    database = os.environ.get("FLITFANCY_DB_PATH")
    return (Path(database).parent if database else Path(__file__).resolve().parent / "data") / "model-consultations.sqlite3"


class ConsultationStore:
    def __init__(self, path=None):
        self.path = Path(path) if path else default_path()

    def _connect(self, create=False):
        if not create and not self.path.is_file():
            return None
        if create:
            self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(str(self.path), timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        if create:
            connection.execute("""CREATE TABLE IF NOT EXISTS consultation_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                consultation_id TEXT NOT NULL,
                at TEXT NOT NULL,
                phase TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                content TEXT NOT NULL,
                turn_id TEXT NOT NULL
            )""")
            connection.commit()
        return connection

    def record(self, phase, content, *, consultation_id=None, provider="", model="", turn_id=""):
        if phase not in {"question", "answer", "error"} or not isinstance(content, str) or not content.strip():
            raise ValueError("invalid consultation event")
        identifier = consultation_id or uuid4().hex
        if not isinstance(identifier, str) or len(identifier) > 80:
            raise ValueError("invalid consultation id")
        connection = self._connect(create=True)
        try:
            connection.execute(
                "INSERT INTO consultation_events(consultation_id, at, phase, provider, model, content, turn_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (identifier, datetime.now(timezone.utc).isoformat(), phase, str(provider)[:60], str(model)[:160], content, str(turn_id)[:120]),
            )
            connection.commit()
        finally:
            connection.close()
        return identifier

    def list_events(self, after=0, limit=40):
        after = int(after)
        limit = min(100, max(1, int(limit)))
        if after < 0:
            raise ValueError("invalid consultation cursor")
        connection = self._connect()
        if connection is None:
            return []
        try:
            if after:
                rows = connection.execute(
                    "SELECT * FROM consultation_events WHERE seq > ? ORDER BY seq ASC LIMIT ?", (after, limit),
                ).fetchall()
            else:
                rows = connection.execute(
                    "SELECT * FROM (SELECT * FROM consultation_events ORDER BY seq DESC LIMIT ?) ORDER BY seq ASC", (limit,),
                ).fetchall()
            return [dict(row) for row in rows]
        finally:
            connection.close()
