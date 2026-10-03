"""Exercise real backup/restore, dirty Git files, SQLite WAL, tampering and path safety."""
import contextlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import workspace_backup as backup


with tempfile.TemporaryDirectory(prefix="flit-backup-test-") as temporary, contextlib.ExitStack() as resources:
    root = Path(temporary)
    source = root / "source"
    source.mkdir()
    backup.git(source, "init", "--quiet", "--initial-branch=main")
    backup.git(source, "config", "user.name", "Backup Test")
    backup.git(source, "config", "user.email", "backup-test@example.invalid")
    (source / "file.txt").write_text("baseline\n")
    backup.git(source, "add", "file.txt")
    backup.git(source, "commit", "--quiet", "-m", "baseline")
    head = backup.git(source, "rev-parse", "HEAD")
    backup.git(source, "tag", "v1.0.0")
    (source / "file.txt").write_text("uncommitted draft\n")
    (source / "new.txt").write_text("untracked draft\n")
    private = root / "private.json"
    private.write_text('{"fixture_secret":"DO_NOT_PUBLISH"}')
    sensors = root / "sensors"
    sensors.mkdir()
    (sensors / "sample.csv").write_text("time,channel,value\n1,CH6,75\n")
    connection = sqlite3.connect(root / "source.db")
    resources.callback(connection.close)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE sample(value)")
    connection.execute("INSERT INTO sample VALUES(75)")
    connection.commit()
    config = root / "settings.json"
    config.write_text(json.dumps({"destination": str(root / "backups"), "keep": 1,
        "repositories": [{"name": "site", "source": str(source)}],
        "trees": [{"name": "sensors", "source": str(sensors), "append_only": True}],
        "private_files": [{"name": "config.json", "source": str(private)}],
        "databases": [{"name": "site/backend/data/test.db", "source": str(root / "source.db")}]}))
    with contextlib.redirect_stdout(io.StringIO()):
        snapshot = backup.create(config)
        restored = root / "restored"
        backup.restore(snapshot, restored)
    assert (restored / "site/file.txt").read_text() == "uncommitted draft\n"
    assert (restored / "site/new.txt").read_text() == "untracked draft\n"
    assert backup.git(restored / "site", "rev-parse", "HEAD") == head
    assert backup.git(restored / "site", "tag") == "v1.0.0"
    with contextlib.closing(sqlite3.connect(restored / "site/backend/data/test.db")) as recovered:
        assert recovered.execute("SELECT value FROM sample").fetchone() == (75,)
    assert (restored / "private/config.json").read_bytes() == private.read_bytes()
    assert backup.load_manifest(snapshot)["repositories"][0]["dirty"] is True
    try:
        backup.restore(snapshot, restored)
        raise AssertionError("Nonempty destination accepted")
    except ValueError:
        pass
    for path in ("../escape", "C:/escape", "/escape", "foo\\..\\escape", "file:stream"):
        try:
            backup.child(root, path)
            raise AssertionError("Unsafe path accepted")
        except ValueError:
            pass
    (snapshot / "site/file.txt").write_text("corrupted")
    target = root / "must-not-exist"
    try:
        backup.restore(snapshot, target)
        raise AssertionError("Corrupted snapshot accepted")
    except RuntimeError:
        assert not target.exists(), "Verify before writing any restored files"
    foreign = root / "backups/snapshots/foreign-folder"
    foreign.mkdir()
    (foreign / "keep.txt").write_text("preserve")
    with contextlib.redirect_stdout(io.StringIO()):
        newer = backup.create(config)
    assert newer.exists() and not snapshot.exists()
    assert (foreign / "keep.txt").read_text() == "preserve"
    connection.close()
print("Workspace backup: WAL-safe SQLite, Git history/drafts/tags, private files, corruption rejection, safe restore and bounded rotation passed")
