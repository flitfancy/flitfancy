"""Create and rotate verified SQLite backups for the local FlitFancy database."""

from __future__ import annotations

import argparse
import contextlib
from datetime import datetime
import msvcrt
import os
from pathlib import Path
import re
import sqlite3
import sys


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PROJECT_ROOT / "backend" / "data" / "flitfancy.db"
DEFAULT_DESTINATION = Path(r"B:\FlitFancy\data")
BACKUP_NAME = re.compile(r"^flitfancy-\d{8}-\d{6}(?:-\d{2})?\.db$")


class BackupAlreadyRunning(RuntimeError):
    """Raised when another backup process owns the destination lock."""


def log_line(root: Path, level: str, message: str) -> None:
    line = "%s %-7s %s" % (
        datetime.now().astimezone().isoformat(timespec="seconds"),
        level,
        message,
    )
    print(line, flush=True)
    with (root / "backup.log").open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


@contextlib.contextmanager
def destination_lock(path: Path):
    """Use a Windows file lock so crashed processes do not leave a stale lock."""
    handle = path.open("a+b")
    try:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as error:
            raise BackupAlreadyRunning("another backup is already running") from error
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    finally:
        handle.close()


def resolve_paths(source_text: str, destination_text: str) -> tuple[Path, Path, Path]:
    source = Path(source_text).expanduser().resolve()
    root = Path(destination_text).expanduser().resolve()
    if root == Path(root.anchor):
        raise ValueError("backup destination must not be a drive root")
    daily = (root / "daily").resolve()
    if root not in daily.parents:
        raise ValueError("daily backup directory escaped its destination root")
    if source == daily or daily in source.parents:
        raise ValueError("source database must not be inside the backup directory")
    return source, root, daily


def next_backup_path(daily: Path) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    candidate = daily / ("flitfancy-%s.db" % stamp)
    if not candidate.exists():
        return candidate
    for suffix in range(1, 100):
        candidate = daily / ("flitfancy-%s-%02d.db" % (stamp, suffix))
        if not candidate.exists():
            return candidate
    raise RuntimeError("too many backups created in the same second")


def cleanup_temporary_files(path: Path) -> None:
    for candidate in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        try:
            candidate.unlink()
        except FileNotFoundError:
            pass


def verify_database(path: Path) -> None:
    uri = path.resolve().as_uri() + "?mode=ro"
    with contextlib.closing(sqlite3.connect(uri, uri=True, timeout=30)) as connection:
        rows = connection.execute("PRAGMA quick_check").fetchall()
    if rows != [("ok",)]:
        details = "; ".join(str(row[0]) for row in rows[:5])
        raise RuntimeError("SQLite quick_check failed: " + details)


def create_backup(source: Path, final_path: Path) -> int:
    temporary = final_path.with_name("." + final_path.name + ".tmp")
    cleanup_temporary_files(temporary)
    source_uri = source.resolve().as_uri() + "?mode=ro"
    try:
        with contextlib.closing(
            sqlite3.connect(source_uri, uri=True, timeout=30)
        ) as source_connection:
            with contextlib.closing(
                sqlite3.connect(str(temporary), timeout=30)
            ) as destination_connection:
                destination_connection.execute("PRAGMA synchronous=FULL")
                source_connection.backup(destination_connection, pages=2048, sleep=0.05)
                destination_connection.commit()
                destination_connection.execute("PRAGMA journal_mode=DELETE").fetchone()
        verify_database(temporary)
        os.replace(temporary, final_path)
        return final_path.stat().st_size
    except Exception:
        cleanup_temporary_files(temporary)
        raise


def rotate_backups(daily: Path, keep: int) -> list[Path]:
    backups = [
        path for path in daily.iterdir()
        if path.is_file() and BACKUP_NAME.fullmatch(path.name)
    ]
    backups.sort(key=lambda path: path.stat().st_mtime_ns, reverse=True)
    removed = []
    for path in backups[keep:]:
        path.unlink()
        removed.append(path)
    return removed


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--destination", default=str(DEFAULT_DESTINATION))
    parser.add_argument("--keep", type=int, default=14)
    args = parser.parse_args(argv)
    if args.keep < 1 or args.keep > 365:
        parser.error("--keep must be between 1 and 365")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        source, root, daily = resolve_paths(args.source, args.destination)
        if not source.is_file():
            raise FileNotFoundError("source database does not exist: %s" % source)
        root.mkdir(parents=True, exist_ok=True)
        daily.mkdir(parents=True, exist_ok=True)
        with destination_lock(root / "backup.lock"):
            final_path = next_backup_path(daily)
            size = create_backup(source, final_path)
            removed = rotate_backups(daily, args.keep)
            log_line(
                root,
                "SUCCESS",
                "%s (%d bytes), retained %d, removed %d"
                % (final_path, size, args.keep, len(removed)),
            )
        return 0
    except BackupAlreadyRunning:
        try:
            log_line(root, "SKIP", "another backup is already running")
        except Exception:
            print("backup skipped: another backup is already running", file=sys.stderr)
        return 0
    except Exception as error:
        try:
            log_line(root, "FAILED", "%s: %s" % (type(error).__name__, error))
        except Exception:
            print("backup failed: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
