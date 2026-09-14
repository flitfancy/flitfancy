#!/usr/bin/env python3
"""Repair sensor CSV rows affected by the literal ``pc_time`` write bug.

The backend SQLite copy contains receive timestamps for recent rows.  Within one
board boot, ``uptime_ms`` provides a stable relative clock, so a sufficiently
large cluster of SQLite matches can recover the boot time and therefore every
row in that boot segment.  Segments without a strong SQLite anchor are left
unchanged instead of receiving invented timestamps.

The command is a dry run unless ``--apply`` is supplied.  Before changing any
CSV it copies the byte-for-byte original into the raw-no-time archive.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import shutil
import sqlite3
import statistics
import tempfile
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


CST = timezone(timedelta(hours=8))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_channel(value: object) -> int | None:
    text = str(value or "")
    if text.upper().startswith("CH"):
        text = text[2:]
    try:
        return int(text)
    except ValueError:
        return None


def row_key(row: dict[str, str]) -> tuple[int, int, int, str] | None:
    channel = parse_channel(row.get("channel"))
    try:
        if channel is None:
            return None
        return (
            int(row["uptime_ms"]),
            int(row["cycle"]),
            channel,
            row["sensor"],
        )
    except (KeyError, TypeError, ValueError):
        return None


def load_boot_candidates(database: Path) -> dict[tuple[int, int, int, str], list[float]]:
    candidates: dict[tuple[int, int, int, str], list[float]] = defaultdict(list)
    connection = sqlite3.connect(database)
    try:
        query = "SELECT ts, uptime_ms, cycle, channel, sensor FROM sensors ORDER BY id"
        for ts, uptime_ms, cycle, channel, sensor in connection.execute(query):
            channel_index = parse_channel(channel)
            if channel_index is None or uptime_ms is None or cycle is None:
                continue
            try:
                received_at = datetime.fromisoformat(str(ts)).timestamp()
                key = (int(uptime_ms), int(cycle), channel_index, str(sensor))
                candidates[key].append(received_at - int(uptime_ms) / 1000.0)
            except (TypeError, ValueError):
                continue
    finally:
        connection.close()
    return candidates


def split_boot_segments(rows: list[dict[str, str]]) -> list[tuple[int, int]]:
    if not rows:
        return []
    segments: list[tuple[int, int]] = []
    start = 0
    previous_uptime: int | None = None
    for index, row in enumerate(rows):
        try:
            uptime = int(row["uptime_ms"])
        except (KeyError, TypeError, ValueError):
            uptime = previous_uptime if previous_uptime is not None else 0
        # A small amount of packet reordering is tolerated; a larger decrease
        # identifies a board reboot and therefore a new relative-clock segment.
        if previous_uptime is not None and uptime + 1000 < previous_uptime:
            segments.append((start, index))
            start = index
        previous_uptime = uptime
    segments.append((start, len(rows)))
    return segments


def cluster_candidates(values: list[float], maximum_gap_seconds: float = 10.0) -> list[list[float]]:
    if not values:
        return []
    ordered = sorted(values)
    groups: list[list[float]] = [[ordered[0]]]
    for value in ordered[1:]:
        if value - groups[-1][-1] <= maximum_gap_seconds:
            groups[-1].append(value)
        else:
            groups.append([value])
    return sorted(groups, key=len, reverse=True)


def select_boot_time(
    rows: list[dict[str, str]],
    candidates: dict[tuple[int, int, int, str], list[float]],
) -> tuple[float | None, dict[str, object]]:
    values: list[float] = []
    for row in rows:
        key = row_key(row)
        if key is not None:
            values.extend(candidates.get(key, ()))

    groups = cluster_candidates(values)
    best_count = len(groups[0]) if groups else 0
    second_count = len(groups[1]) if len(groups) > 1 else 0
    required = max(3, min(20, math.ceil(len(rows) * 0.5)))
    accepted = (
        best_count >= required
        and best_count >= max(3, second_count * 3)
    )
    details: dict[str, object] = {
        "rows": len(rows),
        "best_anchor_count": best_count,
        "second_anchor_count": second_count,
        "required_anchor_count": required,
        "accepted": accepted,
    }
    if not accepted:
        return None, details

    boot_time = statistics.median(groups[0])
    deviations = sorted(abs(value - boot_time) for value in groups[0])
    p95_index = min(len(deviations) - 1, math.floor(len(deviations) * 0.95))
    details["boot_time"] = datetime.fromtimestamp(boot_time, CST).isoformat(
        timespec="milliseconds"
    )
    details["anchor_deviation_p95_seconds"] = round(deviations[p95_index], 3)
    return boot_time, details


def format_pc_time(epoch_seconds: float) -> str:
    timestamp = datetime.fromtimestamp(epoch_seconds, CST)
    return timestamp.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def unique_backup_path(backup_root: Path, source: Path, source_hash: str) -> Path:
    candidate = backup_root / source.name
    if not candidate.exists() or sha256(candidate) == source_hash:
        return candidate
    return backup_root / f"{source.stem}-{source_hash[:12]}{source.suffix}"


def repair_file(
    path: Path,
    candidates: dict[tuple[int, int, int, str], list[float]],
    backup_root: Path,
    apply: bool,
) -> dict[str, object]:
    with path.open("r", encoding="utf-8-sig", newline="") as source:
        reader = csv.DictReader(source)
        fieldnames = list(reader.fieldnames or ())
        rows = list(reader)

    result: dict[str, object] = {
        "path": str(path),
        "rows": len(rows),
        "segments": [],
        "repaired_rows": 0,
        "unresolved_rows": 0,
        "changed": False,
    }
    required_fields = {"pc_time", "uptime_ms", "cycle", "channel", "sensor"}
    if not required_fields.issubset(fieldnames):
        result["error"] = "required columns are missing"
        return result

    for start, end in split_boot_segments(rows):
        segment_rows = rows[start:end]
        boot_time, details = select_boot_time(segment_rows, candidates)
        details["start_row"] = start + 2  # CSV header occupies line 1.
        details["end_row"] = end + 1
        repaired_in_segment = 0
        if boot_time is not None:
            for row in segment_rows:
                if row.get("pc_time") != "pc_time":
                    continue
                try:
                    uptime_seconds = int(row["uptime_ms"]) / 1000.0
                except (TypeError, ValueError):
                    continue
                row["pc_time"] = format_pc_time(boot_time + uptime_seconds)
                repaired_in_segment += 1
        details["repaired_rows"] = repaired_in_segment
        result["segments"].append(details)
        result["repaired_rows"] += repaired_in_segment

    result["unresolved_rows"] = sum(
        1 for row in rows if row.get("pc_time") == "pc_time"
    )
    if not result["repaired_rows"]:
        return result

    result["changed"] = True
    if not apply:
        return result

    source_hash = sha256(path)
    backup_root.mkdir(parents=True, exist_ok=True)
    backup_path = unique_backup_path(backup_root, path, source_hash)
    if not backup_path.exists():
        shutil.copy2(path, backup_path)
    if sha256(backup_path) != source_hash:
        raise RuntimeError(f"Backup verification failed: {backup_path}")

    handle, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".repairing", dir=path.parent
    )
    os.close(handle)
    temporary = Path(temporary_name)
    try:
        with temporary.open("w", encoding="utf-8-sig", newline="") as target:
            writer = csv.DictWriter(
                target,
                fieldnames=fieldnames,
                extrasaction="raise",
                lineterminator="\r\n",
            )
            writer.writeheader()
            writer.writerows(rows)
        with temporary.open("r", encoding="utf-8-sig", newline="") as check:
            verified_rows = sum(1 for _ in csv.DictReader(check))
        if verified_rows != len(rows):
            raise RuntimeError(
                f"Row-count verification failed for {path}: {verified_rows} != {len(rows)}"
            )
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

    result["original_sha256"] = source_hash
    result["repaired_sha256"] = sha256(path)
    result["backup_path"] = str(backup_path)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    repository = Path(__file__).resolve().parent.parent
    parser.add_argument(
        "--data-root",
        type=Path,
        default=repository / "data" / "sensors",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=repository / "backend" / "data" / "flitfancy.db",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write repaired files; otherwise only report what would change",
    )
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    database = args.database.resolve()
    sessions_root = data_root / "sessions"
    if not database.is_file():
        parser.error(f"SQLite database not found: {database}")
    if not sessions_root.is_dir():
        parser.error(f"Sessions directory not found: {sessions_root}")

    candidates = load_boot_candidates(database)
    backup_root = data_root / "archive" / "raw-no-time" / "pc-time-literal"
    report = {
        "mode": "apply" if args.apply else "dry-run",
        "created_at": datetime.now(CST).isoformat(timespec="seconds"),
        "database": str(database),
        "files": [],
    }
    for path in sorted(sessions_root.glob("wifi-*.csv")):
        report["files"].append(
            repair_file(path, candidates, backup_root, args.apply)
        )

    totals = {
        "files": len(report["files"]),
        "changed_files": sum(bool(item["changed"]) for item in report["files"]),
        "rows": sum(int(item["rows"]) for item in report["files"]),
        "repaired_rows": sum(int(item["repaired_rows"]) for item in report["files"]),
        "unresolved_rows": sum(int(item["unresolved_rows"]) for item in report["files"]),
    }
    report["totals"] = totals

    if args.apply:
        reports_root = data_root / "repair-reports"
        reports_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(CST).strftime("%Y%m%d-%H%M%S")
        report_path = reports_root / f"timestamp-repair-{stamp}.json"
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        report["report_path"] = str(report_path)

    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
