from __future__ import annotations

import csv
import json
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    repair_script = root / "scripts" / "repair_sensor_timestamps.py"
    cst = timezone(timedelta(hours=8))
    boot_time = datetime(2026, 9, 12, 9, 0, 0, tzinfo=cst)

    with tempfile.TemporaryDirectory(prefix="flitfancy-sensor-repair-") as folder:
        data_root = Path(folder) / "sensors"
        sessions = data_root / "sessions"
        sessions.mkdir(parents=True)
        database = Path(folder) / "flitfancy.db"
        connection = sqlite3.connect(database)
        try:
            connection.execute(
                "CREATE TABLE sensors ("
                "id INTEGER PRIMARY KEY, ts TEXT, uptime_ms INTEGER, cycle INTEGER, "
                "channel TEXT, sensor TEXT)"
            )
            for index, uptime_ms in enumerate((1000, 2000, 3000), start=1):
                received = boot_time + timedelta(milliseconds=uptime_ms)
                connection.execute(
                    "INSERT INTO sensors(ts, uptime_ms, cycle, channel, sensor) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        received.isoformat(timespec="milliseconds"),
                        uptime_ms,
                        index,
                        "CH0",
                        "CH0 SHT41",
                    ),
                )
            connection.commit()
        finally:
            connection.close()

        session = sessions / "wifi-20260912-090000.csv"
        fields = ["pc_time", "uptime_ms", "cycle", "channel", "sensor", "ok"]
        with session.open("w", encoding="utf-8-sig", newline="") as target:
            writer = csv.DictWriter(target, fieldnames=fields, lineterminator="\r\n")
            writer.writeheader()
            for index, uptime_ms in enumerate((1000, 2000, 3000), start=1):
                writer.writerow(
                    {
                        "pc_time": "pc_time",
                        "uptime_ms": uptime_ms,
                        "cycle": index,
                        "channel": 0,
                        "sensor": "CH0 SHT41",
                        "ok": 1,
                    }
                )
            # A rebooted segment without SQLite anchors must remain explicitly unknown.
            writer.writerow(
                {
                    "pc_time": "pc_time",
                    "uptime_ms": 1,
                    "cycle": 0,
                    "channel": 0,
                    "sensor": "CH0 SHT41",
                    "ok": 1,
                }
            )
        original = session.read_bytes()

        run = subprocess.run(
            [
                sys.executable,
                str(repair_script),
                "--data-root",
                str(data_root),
                "--database",
                str(database),
                "--apply",
            ],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        report = json.loads(run.stdout)
        assert report["totals"]["repaired_rows"] == 3
        assert report["totals"]["unresolved_rows"] == 1

        with session.open("r", encoding="utf-8-sig", newline="") as source:
            rows = list(csv.DictReader(source))
        assert [row["pc_time"] for row in rows[:3]] == [
            "2026-09-12 09:00:01.000",
            "2026-09-12 09:00:02.000",
            "2026-09-12 09:00:03.000",
        ]
        assert rows[3]["pc_time"] == "pc_time"

        backup = data_root / "archive" / "raw-no-time" / "pc-time-literal" / session.name
        assert backup.read_bytes() == original
        print("PASS: timestamp recovery is anchored, atomic, and preserves unknown rows.")


if __name__ == "__main__":
    main()
