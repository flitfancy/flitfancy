"""FlitFancy 的 SQLite 连接、迁移、历史聚合与保留策略。"""

import os
import sqlite3
import threading
import time
from datetime import datetime, timedelta

from flitfancy_core import CST
from flitfancy_sensors import SENSOR_VALUE_FIELDS


class SQLiteStore:
    def __init__(self, path, sensor_retention_days=14, prune_interval_seconds=3600):
        self.path = os.path.abspath(path)
        self.data_dir = os.path.dirname(self.path)
        self.sensor_retention_days = sensor_retention_days
        self.prune_interval_seconds = prune_interval_seconds
        self._prune_lock = threading.Lock()
        self._last_prune = 0.0

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def initialize(self):
        os.makedirs(self.data_dir, exist_ok=True)
        connection = self.connect()
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA wal_autocheckpoint=1000")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS sensors(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT, board TEXT, uptime_ms INTEGER, cycle INTEGER,
                channel TEXT, sensor TEXT, ok INTEGER,
                temp_c REAL, rh_pct REAL, pressure_pa REAL,
                als_raw REAL, uv_raw REAL,
                voc_index REAL, nox_index REAL, co2_ppm REAL,
                extra TEXT)"""
        )
        sensor_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(sensors)").fetchall()
        }
        if "board" not in sensor_columns:
            connection.execute("ALTER TABLE sensors ADD COLUMN board TEXT")
            connection.execute(
                "UPDATE sensors SET board = 'firefly-r1-1' WHERE board IS NULL"
            )
        if "uptime_ms" not in sensor_columns:
            connection.execute("ALTER TABLE sensors ADD COLUMN uptime_ms INTEGER")
        if "cycle" not in sensor_columns:
            connection.execute("ALTER TABLE sensors ADD COLUMN cycle INTEGER")
        connection.execute(
            """CREATE TABLE IF NOT EXISTS notes(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT, author TEXT, content TEXT)"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS memories(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                memory_date TEXT NOT NULL,
                perspective TEXT NOT NULL,
                source TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0,
                time_precision TEXT NOT NULL DEFAULT 'second')"""
        )
        memory_columns = {
            row[1] for row in connection.execute("PRAGMA table_info(memories)").fetchall()
        }
        if "memory_time" not in memory_columns:
            connection.execute("ALTER TABLE memories ADD COLUMN memory_time TEXT")
            connection.execute(
                """UPDATE memories
                   SET memory_time = memory_date || 'T00:00:00+08:00'
                   WHERE memory_time IS NULL OR memory_time = ''"""
            )
        if "time_precision" not in memory_columns:
            connection.execute(
                "ALTER TABLE memories ADD COLUMN "
                "time_precision TEXT NOT NULL DEFAULT 'second'"
            )
            connection.execute("UPDATE memories SET time_precision = 'date'")
        needs_title_merge = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM memories "
            "WHERE title IS NOT NULL AND title != '' LIMIT 1)"
        ).fetchone()[0]
        if needs_title_merge:
            connection.execute(
                """UPDATE memories
                   SET content = CASE
                         WHEN trim(title) NOT IN ('', '.')
                         THEN trim(title) || CASE
                           WHEN trim(content) != '' THEN '\n' || content ELSE '' END
                         ELSE content
                       END,
                       title = ''
                   WHERE title IS NOT NULL AND title != ''"""
            )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS anchors(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uid TEXT UNIQUE NOT NULL,
                created_at TEXT NOT NULL,
                anchor_time TEXT NOT NULL,
                time_precision TEXT NOT NULL DEFAULT 'second',
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                synced INTEGER NOT NULL DEFAULT 0)"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS commands(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT, command TEXT, status TEXT)"""
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_sensors_board_channel_id "
            "ON sensors(board, channel, id DESC)"
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_sensors_ts ON sensors(ts)")
        connection.execute(
            "CREATE INDEX IF NOT EXISTS idx_sensors_channel_ts "
            "ON sensors(channel, ts)"
        )
        connection.commit()
        connection.close()
        self.maybe_prune(force=True)

    def compute_history_buckets(self, hours, channel=None):
        """按 10 分钟桶聚合传感器历史；channel 为空时覆盖全部通道。"""
        if hours < 1 or hours > 72:
            hours = 24
        cutoff = (
            datetime.now(CST) - timedelta(hours=hours)
        ).isoformat(timespec="seconds")
        aggregate_parts = []
        for column in SENSOR_VALUE_FIELDS:
            aggregate_parts.append(
                "AVG(%s) AS %s, MIN(%s) AS %s_min, MAX(%s) AS %s_max"
                % (column, column, column, column, column, column)
            )
        for column in (
            "clear_raw", "nir_raw",
            "f1_415", "f2_445", "f3_480", "f4_515",
            "f5_555", "f6_590", "f7_630", "f8_680",
            "sraw_voc", "sraw_nox",
        ):
            expression = "CAST(json_extract(extra, '$." + column + "') AS REAL)"
            aggregate_parts.append(
                "AVG(%s) AS %s, MIN(%s) AS %s_min, MAX(%s) AS %s_max"
                % (expression, column, expression, column, expression, column)
            )
        select = (
            "substr(ts, 1, 15) || '0:00+08:00' AS bucket, COUNT(*) AS n, "
            + ", ".join(aggregate_parts)
        )
        where = "ts >= ?"
        args = [cutoff]
        group = "bucket"
        if channel:
            where += " AND channel = ?"
            args.append(channel)
        else:
            select = "channel, " + select
            group = "channel, bucket"
        connection = self.connect()
        rows = connection.execute(
            "SELECT " + select + " FROM sensors WHERE " + where
            + " GROUP BY " + group + " ORDER BY " + group,
            args,
        ).fetchall()
        connection.close()
        return [dict(row) for row in rows]

    def prune_sensor_history(self):
        """只清理 SQLite 查询副本；原始 CSV 归档不归本类管理。"""
        cutoff = (
            datetime.now(CST) - timedelta(days=self.sensor_retention_days)
        ).isoformat(timespec="milliseconds")
        connection = self.connect()
        try:
            cursor = connection.execute("DELETE FROM sensors WHERE ts < ?", (cutoff,))
            connection.commit()
            return max(0, cursor.rowcount)
        finally:
            connection.close()

    def maybe_prune(self, force=False):
        now = time.monotonic()
        if not force and now - self._last_prune < self.prune_interval_seconds:
            return 0
        with self._prune_lock:
            now = time.monotonic()
            if not force and now - self._last_prune < self.prune_interval_seconds:
                return 0
            deleted = self.prune_sensor_history()
            self._last_prune = now
            return deleted
