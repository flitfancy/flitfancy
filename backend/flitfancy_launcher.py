"""Private launch cards and short-lived desktop jobs; never synced to the public Worker."""
import csv
import json
import os
import re
import secrets
import sqlite3
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from flitfancy_launcher_icons import IconCache

EXTENSIONS = {".exe", ".lnk", ".bat", ".cmd", ".ps1", ".py"}
BATCH_UNSAFE = re.compile(r'[&|<>^%!"\r\n]')


class LauncherError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def private_directory(directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        system = Path(os.environ["SystemRoot"]) / "System32"
        identity = subprocess.run([str(system / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
                                  capture_output=True, text=True, check=True,
                                  creationflags=subprocess.CREATE_NO_WINDOW)
        sid = next(csv.reader(identity.stdout.strip().splitlines()))[-1]
        if not re.fullmatch(r"S-1-[0-9-]+", sid):
            raise RuntimeError("Cannot resolve the launcher's Windows account")
        subprocess.run([str(system / "icacls.exe"), str(directory), "/inheritance:r", "/grant:r",
                        "*" + sid + ":(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
                       capture_output=True, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        directory.chmod(0o700)
    return directory


def local_path(value, directory=False):
    if not isinstance(value, str) or not value or len(value) > 1024 or any(c in value for c in ('\0', '\r', '\n')):
        raise LauncherError("请填写完整的本机路径")
    path = Path(value)
    if not path.is_absolute() or value.startswith(("\\\\", "//")):
        raise LauncherError("请使用本机绝对路径")
    path = path.resolve()
    if (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise LauncherError("本机找不到这个目录" if directory else "本机找不到这个文件")
    return str(path)


def normalize_target(data):
    target = local_path(data.get("path", ""))
    extension = Path(target).suffix.lower()
    if extension not in EXTENSIONS:
        raise LauncherError("支持 exe、lnk、bat、cmd、ps1 和 py 文件")
    name = data.get("name") or Path(target).stem
    if not isinstance(name, str) or not name.strip() or len(name) > 80:
        raise LauncherError("名称请控制在 80 字以内")
    args = data.get("args", [])
    if not isinstance(args, list) or len(args) > 32 or any(
        not isinstance(a, str) or len(a) > 2048 or any(c in a for c in ('\0', '\r', '\n')) for a in args
    ) or sum(map(len, args)) > 8192:
        raise LauncherError("启动参数过长或格式不正确")
    if extension in {".bat", ".cmd"} and any(BATCH_UNSAFE.search(s) for s in [target, *args]):
        raise LauncherError('批处理路径和参数不能包含 & | < > ^ % ! 或双引号')
    working_dir = local_path(data["working_dir"], directory=True) if data.get("working_dir") else ""
    interpreter = local_path(data["interpreter"]) if extension == ".py" and data.get("interpreter") else ""
    if interpreter and os.name == "nt" and Path(interpreter).suffix.lower() != ".exe":
        raise LauncherError("Python 解释器请选择 exe 文件")
    hidden = data.get("hidden", extension not in {".exe", ".lnk"})
    if not isinstance(hidden, bool):
        raise LauncherError("窗口选项格式不正确")
    return dict(name=name.strip(), path=target, args=args, working_dir=working_dir,
                interpreter=interpreter, hidden=hidden)


class LauncherService:
    def __init__(self, directory):
        # Lazy initialization keeps unrelated imports/tests and audio startup independent.
        self.directory = Path(directory)
        self._ready = False
        self._init_lock = threading.Lock()
        self._icons = IconCache()

    @contextmanager
    def connect(self):
        with self._init_lock:
            if not self._ready:
                private_directory(self.directory)
                with sqlite3.connect(self.directory / "launcher.db") as con:
                    con.executescript("""
                        CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated REAL NOT NULL);
                        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, card_id TEXT, kind TEXT NOT NULL,
                            payload TEXT NOT NULL, state TEXT NOT NULL, created REAL NOT NULL,
                            updated REAL NOT NULL, result TEXT NOT NULL DEFAULT '{}');
                        CREATE TABLE IF NOT EXISTS agent(id INTEGER PRIMARY KEY CHECK(id=1), seen REAL NOT NULL);
                        CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created);
                    """)
                con.close()
                self._ready = True
        con = sqlite3.connect(self.directory / "launcher.db", timeout=5)
        con.row_factory = sqlite3.Row
        try:
            with con:
                yield con
        finally:
            con.close()

    @staticmethod
    def expire(con):
        now = time.time()
        con.execute("UPDATE jobs SET state='expired', updated=?, result=? WHERE "
                    "(state='pending' AND created<?) OR (state='dispatched' AND updated<?)",
                    (now, json.dumps({"message": "启动请求已过期，请重新点击"}), now-10, now-300))
        con.execute("DELETE FROM jobs WHERE created<? AND state NOT IN ('pending','dispatched')", (now-86400,))

    def catalog(self):
        with self.connect() as con:
            self.expire(con)
            cards = [dict(id=row["id"], **json.loads(row["payload"])) for row in con.execute("SELECT * FROM cards ORDER BY updated,id")]
            icons = self._icons.get([card["path"] for card in cards])
            for card in cards:
                card["icon"] = icons.get(card["path"], "")
            agent = con.execute("SELECT seen FROM agent WHERE id=1").fetchone()
            jobs = [dict(id=row["id"], card_id=row["card_id"], kind=row["kind"], state=row["state"],
                         **json.loads(row["result"])) for row in con.execute("SELECT * FROM jobs ORDER BY created DESC LIMIT 40")]
            return {"ok": True, "cards": cards, "jobs": jobs,
                    "agent_online": bool(agent and time.time()-agent["seen"] < 8)}

    def save(self, data):
        payload = normalize_target(data)
        card_id = data.get("id") or secrets.token_hex(16)
        if not isinstance(card_id, str) or not re.fullmatch(r"[a-f0-9]{32}", card_id):
            raise LauncherError("启动卡片标识不正确")
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            existing = con.execute("SELECT id FROM cards WHERE id=?", (card_id,)).fetchone()
            if data.get("id") and not existing:
                raise LauncherError("这张启动卡片已不存在", 404)
            if not existing and con.execute("SELECT COUNT(*) FROM cards").fetchone()[0] >= 100:
                raise LauncherError("最多保留 100 张启动卡片")
            con.execute("INSERT INTO cards VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
                        (card_id, json.dumps(payload), time.time()))
            con.execute("UPDATE jobs SET state='cancelled' WHERE card_id=? AND state='pending'", (card_id,))
        return {"ok": True, "card": dict(id=card_id, **payload)}

    def delete(self, card_id):
        with self.connect() as con:
            con.execute("DELETE FROM cards WHERE id=?", (card_id,))
            con.execute("UPDATE jobs SET state='cancelled' WHERE card_id=? AND state='pending'", (card_id,))
        return {"ok": True}

    def enqueue(self, kind, card_id=None):
        if kind not in {"launch", "pick"}:
            raise LauncherError("不支持的操作")
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            self.expire(con)
            agent = con.execute("SELECT seen FROM agent WHERE id=1").fetchone()
            if not agent or time.time()-agent["seen"] >= 8:
                raise LauncherError("本机桌面助手未连接，请先在本机登录桌面并启动助手", 409)
            if con.execute("SELECT id FROM jobs WHERE state IN ('pending','dispatched') LIMIT 1").fetchone():
                raise LauncherError("上一项操作尚未完成，请稍候", 409)
            payload = {}
            if kind == "launch":
                row = con.execute("SELECT payload FROM cards WHERE id=?", (card_id,)).fetchone()
                if not row:
                    raise LauncherError("启动卡片不存在", 404)
                if con.execute("SELECT id FROM jobs WHERE card_id=? AND created>?", (card_id, time.time()-3)).fetchone():
                    raise LauncherError("刚刚已经发送启动请求，请稍候", 409)
                payload = normalize_target(json.loads(row["payload"]))
            job_id = secrets.token_hex(16)
            con.execute("INSERT INTO jobs(id,card_id,kind,payload,state,created,updated) VALUES(?,?,?,?,?,?,?)",
                        (job_id, card_id, kind, json.dumps(payload), "pending", time.time(), time.time()))
        return {"ok": True, "job_id": job_id}

    def claim(self, accept=True):
        with self.connect() as con:
            con.execute("BEGIN IMMEDIATE")
            self.expire(con)
            con.execute("INSERT INTO agent VALUES(1,?) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen", (time.time(),))
            row = con.execute("SELECT * FROM jobs WHERE state='pending' ORDER BY created LIMIT 1").fetchone() if accept else None
            if not row:
                return None
            con.execute("UPDATE jobs SET state='dispatched',updated=? WHERE id=? AND state='pending'", (time.time(), row["id"]))
            return dict(id=row["id"], kind=row["kind"], payload=json.loads(row["payload"]))

    def finish(self, job_id, state, result):
        if state not in {"done", "failed", "cancelled"}:
            raise ValueError("Invalid job result")
        with self.connect() as con:
            con.execute("UPDATE jobs SET state=?,result=?,updated=? WHERE id=? AND state='dispatched'",
                        (state, json.dumps(result), time.time(), job_id))

    def resolve_drop(self, name):
        if not isinstance(name, str) or Path(name).name != name or any(c in name for c in ('/', '\\', '\0')):
            raise LauncherError("文件名不正确")
        # Only common shortcut locations; never scan the whole disk or accept uploaded executable bytes.
        roots = [Path.home()/"Desktop", Path(os.environ.get("PUBLIC", str(Path.home())))/"Desktop"]
        if os.environ.get("OneDrive"):
            roots.append(Path(os.environ["OneDrive"])/"Desktop")
        matches = {str((root/name).resolve()) for root in roots if (root/name).is_file()}
        return {"ok": True, "path": matches.pop() if len(matches) == 1 else "", "name": name}
