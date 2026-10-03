"""Create, verify and restore private FlitFancy workspace snapshots on Windows."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from datetime import datetime

from backup_sqlite import create_backup, destination_lock, verify_database

FORMAT = "flitfancy-workspace-v1"
SNAPSHOT_NAME = re.compile(r"workspace-\d{8}-\d{6}-[a-f0-9]{8}")
SKIP_DIRS = {".git", ".pio", ".ota-build", "__pycache__", "node_modules", ".wrangler"}


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
    if result.returncode:
        raise RuntimeError("Git operation failed: " + args[0])
    return result.stdout.decode("utf-8").strip()


def digest(path, size=None):
    sha = hashlib.sha256()
    with path.open("rb") as stream:
        remaining = size
        while remaining is None or remaining > 0:
            chunk = stream.read(1024 * 1024 if remaining is None else min(remaining, 1024 * 1024))
            if not chunk:
                if remaining:
                    raise RuntimeError("Source truncated during capture")
                break
            sha.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return sha.hexdigest()


def child(root, relative):
    # Reject Windows drive names and both slash styles before resolving paths.
    text = str(relative)
    parts = PurePosixPath(text).parts
    if not text or "\\" in text or ":" in text or text.startswith("/") or ".." in parts:
        raise ValueError("Unsafe snapshot path")
    target = root.joinpath(*parts).resolve()
    if target == root or root not in target.parents:
        raise ValueError("Snapshot path escaped its root")
    return target


def copy_file(source, target, append_only=False):
    target.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(3):
        before = source.stat()
        if source.is_symlink() or not source.is_file():
            raise ValueError("File links are not supported")
        sha = hashlib.sha256()
        with source.open("rb") as incoming, target.open("wb") as outgoing:
            remaining = before.st_size
            while remaining:
                chunk = incoming.read(min(remaining, 1024 * 1024))
                if not chunk:
                    break
                outgoing.write(chunk)
                sha.update(chunk)
                remaining -= len(chunk)
        after = source.stat()
        stable = remaining == 0 and before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns
        if append_only and remaining == 0 and after.st_size >= before.st_size:
            stable = digest(source, before.st_size) == sha.hexdigest()
        if stable:
            return {"size": before.st_size, "sha256": sha.hexdigest(),
                    "source_mtime_ns": before.st_mtime_ns,
                    "capture": "verified-prefix" if append_only else "stable-file"}
    raise RuntimeError("Source kept changing during capture")


def load_manifest(snapshot):
    manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("format") != FORMAT or not isinstance(manifest.get("files"), list):
        raise ValueError("Unsupported snapshot format")
    seen = set()
    for record in manifest["files"]:
        name = record["path"]
        child(snapshot, name)
        if name.casefold() in seen or not re.fullmatch(r"[a-f0-9]{64}", record["sha256"]):
            raise ValueError("Invalid or duplicate snapshot record")
        seen.add(name.casefold())
    return manifest


def verify(snapshot):
    snapshot = snapshot.resolve()
    manifest = load_manifest(snapshot)
    for record in manifest["files"]:
        path = child(snapshot, record["path"])
        if not path.is_file() or path.stat().st_size != record["size"] or digest(path) != record["sha256"]:
            raise RuntimeError("Snapshot file failed verification: " + record["path"])
    for database in manifest.get("databases", []):
        verify_database(child(snapshot, database))
    with tempfile.TemporaryDirectory(prefix="flit-bundle-verify-") as temporary:
        git(Path(temporary), "init", "--bare", "--quiet")
        for repository in manifest.get("repositories", []):
            git(Path(temporary), "bundle", "verify", str(child(snapshot, repository["bundle"])))
    return manifest


def protect_directory(path):
    """Restrict a new backup subtree to its owner, administrators and SYSTEM."""
    command = (
        "$ErrorActionPreference='Stop'; $path=$env:FLIT_BACKUP_ACL_PATH; "
        "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; "
        "$acl=[Security.AccessControl.DirectorySecurity]::new(); "
        "$acl.SetAccessRuleProtection($true,$false); "
        "foreach($identity in @($sid.Value,'S-1-5-18','S-1-5-32-544')) { "
        "$rule=[Security.AccessControl.FileSystemAccessRule]::new("
        "[Security.Principal.SecurityIdentifier]::new($identity),"
        "'FullControl','ContainerInherit,ObjectInherit','None','Allow'); "
        "$acl.AddAccessRule($rule) }; $folder=[IO.DirectoryInfo]::new($path); $folder.SetAccessControl($acl)"
    )
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                            env={**os.environ, "FLIT_BACKUP_ACL_PATH": str(path)}, capture_output=True)
    if result.returncode:
        raise RuntimeError("Could not restrict backup directory permissions")


def tree_files(root):
    for base, directories, names in os.walk(root, followlinks=False):
        directories[:] = [name for name in sorted(directories)
                          if name not in SKIP_DIRS and not (Path(base) / name).is_symlink()]
        for name in sorted(names):
            path = Path(base) / name
            if not path.is_symlink():
                yield path


def create(config_path):
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    root = Path(config["destination"]).resolve()
    if root == Path(root.anchor):
        raise ValueError("Backup destination cannot be a drive root")
    source_roots = [Path(item["source"]).resolve() for key in ("repositories", "trees", "databases", "private_files")
                    for item in config.get(key, [])]
    if any(root == source or source in root.parents for source in source_roots):
        raise ValueError("Backup destination is inside a source")
    keep = int(config.get("keep", 14))
    if not 1 <= keep <= 365:
        raise ValueError("Keep must be between 1 and 365")
    root.mkdir(parents=True, exist_ok=True)
    protect_directory(root)
    snapshots = root / "snapshots"
    snapshots.mkdir(exist_ok=True)
    with destination_lock(root / "workspace.lock"):
        name = "workspace-" + datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:8]
        final = child(snapshots, name)
        stage = child(snapshots, ".pending-" + name)
        stage.mkdir()
        manifest = {"format": FORMAT, "created_at": datetime.now().astimezone().isoformat(),
                    "config_source": str(config_path.resolve()), "files": [], "repositories": [], "databases": []}
        seen = set()

        def capture(source, relative, append_only=False):
            target = child(stage, relative)
            if relative.casefold() in seen:
                raise ValueError("Overlapping backup sources")
            record = copy_file(source, target, append_only)
            manifest["files"].append({"path": relative, **record})
            seen.add(relative.casefold())

        for item in config.get("repositories", []):
            source = Path(item["source"]).resolve()
            repo_name = item["name"]
            child(stage, repo_name).mkdir(parents=True, exist_ok=True)
            files = subprocess.run(["git", "-C", str(source), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                                   capture_output=True, check=True).stdout.decode("utf-8").split("\0")
            for relative in sorted(set(files) - {""}):
                capture(child(source, relative), repo_name + "/" + relative)
            bundle = ".versions/" + repo_name + ".bundle"
            bundle_path = child(stage, bundle)
            bundle_path.parent.mkdir(exist_ok=True)
            git(source, "bundle", "create", str(bundle_path), "--all")
            manifest["files"].append({"path": bundle, "size": bundle_path.stat().st_size, "sha256": digest(bundle_path)})
            manifest["repositories"].append({"name": repo_name, "head": git(source, "rev-parse", "HEAD"),
                                               "branch": git(source, "branch", "--show-current"),
                                               "dirty": bool(git(source, "status", "--porcelain")), "bundle": bundle})
        for item in config.get("trees", []):
            source = Path(item["source"]).resolve()
            if not source.is_dir():
                raise FileNotFoundError("Required backup directory is missing")
            for path in tree_files(source):
                relative = path.relative_to(source).as_posix()
                if any(path.match(pattern) for pattern in item.get("exclude", [])):
                    continue
                capture(path, item["name"] + "/" + relative, item.get("append_only", False))
        for item in config.get("private_files", []):
            source = Path(item["source"]).resolve()
            if not source.is_file():
                if item.get("optional", False):
                    continue
                raise FileNotFoundError("Required private backup file is missing")
            capture(source, "private/" + item["name"])
        for item in config.get("databases", []):
            relative = item["name"]
            target = child(stage, relative)
            if relative.casefold() in seen:
                raise ValueError("Database overlaps another backup source")
            target.parent.mkdir(parents=True, exist_ok=True)
            create_backup(Path(item["source"]).resolve(), target)
            manifest["files"].append({"path": relative, "size": target.stat().st_size, "sha256": digest(target), "capture": "sqlite-online-backup"})
            manifest["databases"].append(relative)
        (stage / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        verify(stage)
        os.replace(stage, final)
        complete = []
        for candidate in snapshots.iterdir():
            if candidate.is_dir() and not candidate.is_symlink() and SNAPSHOT_NAME.fullmatch(candidate.name):
                if load_manifest(candidate).get("format") == FORMAT:
                    complete.append(candidate)
        for candidate in sorted(complete, key=lambda path: path.name, reverse=True)[keep:]:
            resolved = candidate.resolve()
            if resolved.parent != snapshots.resolve() or not SNAPSHOT_NAME.fullmatch(resolved.name):
                raise ValueError("Unsafe backup rotation target")
            shutil.rmtree(resolved)
        (root / "latest.json").write_text(json.dumps({"snapshot": str(final), "created_at": manifest["created_at"]}) + "\n", encoding="utf-8")
        print(json.dumps({"snapshot": str(final), "files": len(manifest["files"]),
                          "bytes": sum(record["size"] for record in manifest["files"]), "verified": True}))
        return final


def restore(snapshot, destination):
    manifest = verify(snapshot)
    destination = destination.resolve()
    if destination == Path(destination.anchor) or destination == snapshot.resolve() or snapshot.resolve() in destination.parents:
        raise ValueError("Unsafe restore destination")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("Restore destination must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    protect_directory(destination)
    for record in manifest["files"]:
        source = child(snapshot.resolve(), record["path"])
        target = child(destination, record["path"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        if digest(target) != record["sha256"]:
            raise RuntimeError("Restored file failed verification")
    for repository in manifest.get("repositories", []):
        repo = child(destination, repository["name"])
        git(repo, "init", "--quiet", "--initial-branch=main")
        git(repo, "fetch", "--quiet", "--update-head-ok", str(child(destination, repository["bundle"])),
            "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*")
        branch = repository["branch"] or "main"
        git(repo, "check-ref-format", "--branch", branch)
        git(repo, "symbolic-ref", "HEAD", "refs/heads/" + branch)
        git(repo, "reset", "--mixed", "--quiet", repository["head"])
    for database in manifest.get("databases", []):
        verify_database(child(destination, database))
    (destination / "snapshot-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"restored_to": str(destination), "files": len(manifest["files"]), "verified": True}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("create").add_argument("--config", type=Path, required=True)
    sub.add_parser("verify").add_argument("--snapshot", type=Path, required=True)
    recovery = sub.add_parser("restore")
    recovery.add_argument("--snapshot", type=Path, required=True)
    recovery.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.action == "create":
            create(args.config)
        elif args.action == "verify":
            manifest = verify(args.snapshot)
            print(json.dumps({"files": len(manifest["files"]), "verified": True}))
        else:
            restore(args.snapshot, args.destination)
        return 0
    except Exception as error:
        # Private files can contain credentials; never print their contents or subprocess output.
        print("Workspace backup failed: " + type(error).__name__ + ": " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
