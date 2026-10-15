"""Content ordering regressions: isolated SQLite and fake Worker, no live services."""

import importlib
import json
import os
import sqlite3
import tempfile
import threading
import unittest
from contextlib import closing
from dataclasses import fields
from unittest import mock

from flitfancy_core import CST
from flitfancy_http import HttpDependencies, create_handler
from flitfancy_observations import ObservationService
from flitfancy_storage import SQLiteStore
from flitfancy_sync import WorkerClient


STAMP = "2026-10-15T12:00:00+08:00"
TABLES = ("memories", "anchors", "essays", "observations", "observation_links")
SITE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "docs"))

# Deliberately retain the old schema, so migration coverage survives changes to
# the current CREATE TABLE statements. No private database is copied or opened.
LEGACY_COLUMNS = {
    "memories": """memory_date TEXT NOT NULL, perspective TEXT NOT NULL,
        source TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        time_precision TEXT NOT NULL DEFAULT 'second', memory_time TEXT""",
    "anchors": """anchor_time TEXT NOT NULL, time_precision TEXT NOT NULL DEFAULT 'second',
        horizon TEXT NOT NULL DEFAULT 'now', project TEXT NOT NULL DEFAULT 'pending',
        title TEXT NOT NULL, content TEXT NOT NULL, badge TEXT NOT NULL DEFAULT '',
        badge_kind TEXT NOT NULL DEFAULT ''""",
    "essays": """updated_at TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', display_order INTEGER NOT NULL DEFAULT 100""",
    "observations": """updated_at TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL, content TEXT NOT NULL,
        discovered_at TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft'""",
    "observation_links": """updated_at TEXT NOT NULL, source_uid TEXT NOT NULL,
        target_uid TEXT NOT NULL, relation TEXT NOT NULL,
        strength TEXT NOT NULL DEFAULT 'medium'""",
}


def fixture_row(table):
    row = {"uid": "fixture-%s-0001" % table, "created_at": STAMP, "synced": 0}
    if table == "memories":
        row.update(memory_date=STAMP[:10], memory_time=STAMP, perspective="me",
                   source="manual", title="", content="Original diary", time_precision="second")
    elif table == "anchors":
        row.update(anchor_time=STAMP, time_precision="second", horizon="now",
                   project="flitfancy", title="Original anchor", content="Original body",
                   badge="", badge_kind="")
    elif table == "essays":
        row.update(updated_at=STAMP, title="Original essay", content="Original body",
                   status="public", display_order=100)
    elif table == "observations":
        row.update(updated_at=STAMP, title="Original observation", category="物",
                   tags_json='["fixture"]', summary="Original summary", content="Original body",
                   discovered_at=STAMP[:10], source_name="", source_url="", status="public")
    else:
        row.update(updated_at=STAMP, source_uid="fixture-observation-alpha",
                   target_uid="fixture-observation-beta", relation="延伸", strength="medium")
    return row


def insert_row(store, table, row):
    # Table/column names are fixture constants, never values from the application.
    with closing(store.connect()) as connection:
        connection.execute("INSERT INTO %s(%s) VALUES(%s)" % (
            table, ",".join(row), ",".join("?" for _ in row)), tuple(row.values()))
        connection.commit()


class FakeResponse:
    status = 200

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.body).encode("utf-8")


class FakeOpener:
    def __init__(self, body):
        self.body = body
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return FakeResponse(self.body)


class ContentSyncTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.import_directory = tempfile.TemporaryDirectory(prefix="flitfancy-sync-import-")
        directory = cls.import_directory.name
        cls.environment = mock.patch.dict(os.environ, {
            "FLITFANCY_DB_PATH": os.path.join(directory, "import.db"),
            "FLITFANCY_AI_CONFIG_PATH": os.path.join(directory, "config.json"),
            "FLITFANCY_SENSOR_RAW_DATA_DIR": os.path.join(directory, "sensor-raw"),
        })
        cls.environment.start()
        cls.server = importlib.import_module("server")

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        cls.import_directory.cleanup()

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="flitfancy-content-sync-")
        self.addCleanup(self.directory.cleanup)
        self.store = SQLiteStore(os.path.join(self.directory.name, "fixture.db"))
        self.store.initialize()
        patcher = mock.patch.object(self.server, "_store", self.store)
        patcher.start()
        self.addCleanup(patcher.stop)
        offline = lambda: (0, "fixture offline")
        self.observations = ObservationService(self.store.connect, lambda: STAMP, offline, offline)
        self.config = {}

        def unexpected(*_args, **_kwargs):
            raise AssertionError("Unexpected dependency: no live services are allowed")

        dependencies = {field.name: unexpected for field in fields(HttpDependencies)}
        dependencies.update(db=self.store.connect, now_iso=lambda: STAMP, cst=CST,
                            site_root=SITE_ROOT, read_local_config=lambda: self.config,
                            sync_pending_memories=offline, sync_pending_anchors=offline,
                            sync_pending_essays=offline, observation_service=self.observations)
        self.handler_class = create_handler(HttpDependencies(**dependencies))

    def row(self, table, uid):
        connection = self.store.connect()
        try:
            return dict(connection.execute("SELECT * FROM %s WHERE uid=?" % table, (uid,)).fetchone())
        finally:
            connection.close()

    def save(self, kind, payload):
        # Invoke the real request-to-SQL handler with an isolated body/response
        # boundary; authentication and HTTP framing have separate policy tests.
        if kind == "observations":
            status, result = self.observations.save_observation(payload)
        elif kind == "observation_links":
            status, result = self.observations.save_link(payload)
        else:
            handler = object.__new__(self.handler_class)
            handler._json_body = lambda: payload
            responses = []
            handler._send = lambda status, result: responses.append((status, result))
            getattr(handler, "_api_%s_create" % {"memories": "memory", "anchors": "anchor", "essays": "essay"}[kind])()
            [(status, result)] = responses
        self.assertIn(status, (200, 201), result)
        return result[{"memories": "memory", "anchors": "anchor", "essays": "essay",
                       "observations": "observation", "observation_links": "link"}[kind]]

    @staticmethod
    def payload(table):
        if table == "memories":
            return {"time": STAMP, "perspective": "me", "content": "Original diary"}
        if table == "anchors":
            return {"time": STAMP, "horizon": "now", "project": "flitfancy",
                    "title": "Original anchor", "content": "Original body"}
        if table == "essays":
            return {"title": "Original essay", "content": "Original body", "status": "public"}
        if table == "observations":
            return {"title": "Original observation", "category": "物", "tags": [],
                    "summary": "Original summary", "content": "Original body",
                    "discovered_at": STAMP[:10], "status": "public"}
        return {"source_uid": "fixture-observation-alpha", "target_uid": "fixture-observation-beta",
                "relation": "延伸", "strength": "medium"}

    def seed_endpoints(self):
        for uid in ("fixture-observation-alpha", "fixture-observation-beta"):
            insert_row(self.store, "observations", dict(fixture_row("observations"), uid=uid))

    def legacy_store(self, filename="legacy.db"):
        path = os.path.join(self.directory.name, filename)
        with closing(sqlite3.connect(path)) as connection:
            for table in TABLES:
                connection.execute("CREATE TABLE %s(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                                   "uid TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, "
                                   "synced INTEGER NOT NULL DEFAULT 0, %s)" % (table, LEGACY_COLUMNS[table]))
            connection.commit()
        legacy = SQLiteStore(path)
        originals = {}
        for table in TABLES:
            originals[table] = dict(fixture_row(table), synced=1)
            insert_row(legacy, table, originals[table])
        return legacy, originals

    def test_legacy_migration_preserves_rows_and_is_idempotent(self):
        legacy, originals = self.legacy_store()
        legacy.initialize()
        legacy.initialize()
        connection = legacy.connect()
        try:
            for table in TABLES:
                row = dict(connection.execute("SELECT * FROM " + table).fetchone())
                self.assertEqual({key: row[key] for key in originals[table] if key != "synced"},
                                 {key: value for key, value in originals[table].items() if key != "synced"})
                self.assertEqual(row["synced"], 0, "First migration must seed the cloud revision ledger")
                self.assertEqual(row["sync_revision"], 1)
                columns = {column[1]: column for column in connection.execute("PRAGMA table_info(%s)" % table)}
                self.assertEqual(columns["sync_revision"][3], 1, "revision must be NOT NULL")
        finally:
            connection.close()
        # Seeding happens once: restarting must preserve an acknowledged newer
        # revision rather than queueing every record again.
        with closing(legacy.connect()) as connection:
            connection.execute("UPDATE essays SET sync_revision=9, synced=1")
            connection.commit()
        legacy.initialize()
        with closing(legacy.connect()) as connection:
            row = connection.execute("SELECT sync_revision, synced FROM essays").fetchone()
            self.assertEqual(tuple(row), (9, 1))

    def test_interrupted_migration_rolls_back_schema_and_requeue_together(self):
        legacy, _ = self.legacy_store("interrupted.db")
        connection = legacy.connect()

        class InterruptedConnection:
            def __getattr__(self, name):
                return getattr(connection, name)

            def execute(self, sql, *args):
                if sql.strip() == "UPDATE memories SET synced = 0":
                    raise RuntimeError("Fixture interruption after adding first revision column")
                return connection.execute(sql, *args)

        try:
            with mock.patch.object(legacy, "connect", return_value=InterruptedConnection()):
                with self.assertRaisesRegex(RuntimeError, "Fixture interruption"):
                    legacy.initialize()
        finally:
            # Closing an interrupted process's connection rolls back its open
            # transaction, just as SQLite recovery does after a process exits.
            connection.close()
        with closing(legacy.connect()) as connection:
            for table in TABLES:
                columns = {column[1] for column in connection.execute("PRAGMA table_info(%s)" % table)}
                self.assertNotIn("sync_revision", columns)
                self.assertEqual(connection.execute("SELECT synced FROM " + table).fetchone()[0], 1)
        legacy.initialize()
        with closing(legacy.connect()) as connection:
            for table in TABLES:
                self.assertEqual(tuple(connection.execute("SELECT sync_revision, synced FROM " + table).fetchone()), (1, 0))

    def test_featured_snapshot_stays_frozen_but_requires_current_public_visibility(self):
        payload = self.payload("essays")
        saved = self.save("essays", payload)
        snapshot = {"uid": saved["uid"], "title": "Selected frozen title",
                    "content": "Selected frozen body", "updated_at": STAMP}
        self.config["featured_essay"] = snapshot
        self.save("essays", dict(payload, uid=saved["uid"], title="New public title", content="New public body"))

        def get_featured():
            handler = object.__new__(self.handler_class)
            responses = []
            handler._send = lambda status, result: responses.append((status, result))
            handler._api_get("/api/essays/featured")
            [(status, result)] = responses
            self.assertEqual(status, 200)
            return result["essay"]

        self.assertEqual(get_featured(), snapshot)
        self.assertEqual(self.row("essays", saved["uid"])["content"], "New public body")
        # Model a stale concurrent featured selection that arrives after the
        # content's visibility changed; the saved configuration still points at
        # its old public snapshot, so the getter must consult current SQLite.
        for status in ("draft", "archived"):
            with self.subTest(status=status):
                with closing(self.store.connect()) as connection:
                    connection.execute("UPDATE essays SET status=? WHERE uid=?", (status, saved["uid"]))
                    connection.commit()
                self.assertIsNone(get_featured())
                self.assertEqual(self.config["featured_essay"], snapshot)
        with closing(self.store.connect()) as connection:
            connection.execute("DELETE FROM essays WHERE uid=?", (saved["uid"],))
            connection.commit()
        self.assertIsNone(get_featured())

    def test_only_matching_revision_can_acknowledge_all_content_tables(self):
        for table in TABLES:
            with self.subTest(table=table):
                source = fixture_row(table)
                insert_row(self.store, table, source)
                current = self.row(table, source["uid"])
                revision = current["sync_revision"]
                self.assertFalse(self.store.mark_synced(table, source["uid"], revision + 1))
                self.assertEqual(self.row(table, source["uid"])["synced"], 0)
                self.assertTrue(self.store.mark_synced(table, source["uid"], revision))
                self.assertEqual(self.row(table, source["uid"])["synced"], 1)
                self.assertFalse(self.store.mark_synced(table, "missing-fixture-uid", revision))

    def test_business_edits_increment_revisions_even_with_identical_timestamps(self):
        self.seed_endpoints()
        for table in TABLES:
            with self.subTest(table=table):
                payload = self.payload(table)
                saved = self.save(table, payload)
                before = self.row(table, saved["uid"])
                self.assertEqual(before["sync_revision"], 1)
                self.assertTrue(self.store.mark_synced(table, saved["uid"], before["sync_revision"]))
                edited = dict(payload, uid=saved["uid"])
                edited["relation" if table == "observation_links" else "content"] = "Edited once"
                self.save(table, edited)
                after = self.row(table, saved["uid"])
                self.assertEqual(after["sync_revision"], before["sync_revision"] + 1)
                self.assertEqual(after["synced"], 0)
                self.assertEqual(after.get("updated_at", after["created_at"]), STAMP)
                self.save(table, edited)
                self.assertEqual(self.row(table, saved["uid"])["sync_revision"], before["sync_revision"] + 2)

    def test_upserted_original_anchor_card_and_builtin_essay_increment(self):
        cases = (
            ("anchors", dict(self.payload("anchors"), uid="legacy-anchor-firefly-brain", badge="进行中", badge_kind="doing")),
            ("essays", dict(self.payload("essays"), uid="builtin-prologue-0001")),
        )
        for table, payload in cases:
            with self.subTest(table=table):
                saved = self.save(table, payload)
                before = self.row(table, saved["uid"])
                self.save(table, dict(payload, content="Updated original card"))
                after = self.row(table, saved["uid"])
                self.assertEqual(after["sync_revision"], before["sync_revision"] + 1)
                self.assertEqual(after["synced"], 0)

    def test_endpoint_visibility_change_invalidates_link_revision(self):
        self.seed_endpoints()
        link = self.save("observation_links", self.payload("observation_links"))
        old = self.row("observation_links", link["uid"])
        self.store.mark_synced("observation_links", link["uid"], old["sync_revision"])
        endpoint = dict(self.payload("observations"), uid="fixture-observation-alpha", status="draft")
        self.save("observations", endpoint)
        changed = self.row("observation_links", link["uid"])
        self.assertGreater(changed["sync_revision"], old["sync_revision"])
        self.assertEqual(changed["synced"], 0)
        self.assertFalse(self.store.mark_synced("observation_links", link["uid"], old["sync_revision"]))
        self.save("observations", dict(endpoint, status="public"))
        self.assertGreater(self.row("observation_links", link["uid"])["sync_revision"], changed["sync_revision"])

    def test_link_visibility_is_captured_with_its_revision(self):
        self.seed_endpoints()
        link = self.save("observation_links", self.payload("observation_links"))
        endpoint = dict(self.payload("observations"), uid="fixture-observation-alpha", status="draft")
        self.save("observations", endpoint)
        [withdrawal] = self.store.pending_rows("observation_links", 20)
        self.assertFalse(withdrawal["sync_published"])
        self.save("observations", dict(endpoint, status="public"))
        # The old withdrawal keeps its captured visibility even after a newer
        # local edit; the cloud independently enforces revision ordering.
        with mock.patch.object(self.server._worker_client, "post", return_value=(True, "")) as post:
            self.server.sync_public_observation_link(withdrawal)
            self.assertEqual(post.call_args.args[1], {"uid": link["uid"], "published": False,
                                                     "sync_revision": withdrawal["sync_revision"]})

    def test_delayed_publish_ack_cannot_hide_a_new_draft(self):
        for table in ("essays", "observations"):
            with self.subTest(table=table):
                payload = self.payload(table)
                saved = self.save(table, payload)
                original = self.row(table, saved["uid"])
                started, release = threading.Event(), threading.Event()
                outcomes, errors = [], []

                def delayed_sender(row):
                    self.assertEqual(row.get("sync_revision"), original.get("sync_revision"))
                    self.assertEqual(row["status"], "public")
                    started.set()
                    if not release.wait(3):
                        raise AssertionError("Test did not release the held publish acknowledgement")
                    return True, ""

                def publish():
                    try:
                        outcomes.append(self.server._sync_pending_rows(table, delayed_sender, 20))
                    except BaseException as error:
                        errors.append(error)

                thread = threading.Thread(target=publish, daemon=True)
                thread.start()
                try:
                    self.assertTrue(started.wait(3), "Old public version must be captured first")
                    self.save(table, dict(payload, uid=saved["uid"], status="draft", content="Private revised body"))
                finally:
                    release.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                draft = self.row(table, saved["uid"])
                self.assertEqual(draft["status"], "draft")
                self.assertEqual(draft["synced"], 0, "Withdrawal must remain queued after the old ack")
                self.assertGreater(draft["sync_revision"], original["sync_revision"])
                self.assertEqual(outcomes[0][0], 0, "An old acknowledgement is not a synced current row")
                delivered = []
                count, _ = self.server._sync_pending_rows(table, lambda row: (delivered.append(row) is None, ""), 20)
                self.assertEqual(count, 1)
                self.assertEqual(delivered[0]["status"], "draft")
                self.assertEqual(delivered[0]["sync_revision"], draft["sync_revision"])
                self.assertEqual(self.row(table, saved["uid"])["synced"], 1)

    def test_worker_requires_matching_revision_and_existing_field_echoes(self):
        config = lambda: {"worker_admin_url": "https://worker.invalid", "worker_admin_token": "x" * 32}
        payload = {"uid": "fixture-worker-0001", "sync_revision": 7}
        for body in ({"ok": True}, {"ok": True, "sync_revision": 6}, {"ok": True, "sync_revision": 8},
                     {"ok": True, "sync_revision": "7"}, {"ok": True, "sync_revision": None}):
            with self.subTest(body=body):
                self.assertFalse(WorkerClient(config, FakeOpener(body)).post("/admin/essays", payload)[0])
        client = WorkerClient(config, FakeOpener({"ok": True, "sync_revision": 7, "strength": "weak"}))
        self.assertEqual(client.post("/admin/essays", payload), (True, ""))
        self.assertEqual(client.post("/admin/observation-links", payload, expected_response={"strength": "weak"}), (True, ""))
        self.assertFalse(client.post("/admin/observation-links", payload, expected_response={"strength": "strong"})[0])

    def test_old_worker_ack_leaves_content_pending(self):
        insert_row(self.store, "essays", fixture_row("essays"))
        client = WorkerClient(lambda: {"worker_admin_url": "https://worker.invalid", "worker_admin_token": "x" * 32},
                              FakeOpener({"ok": True}))
        with mock.patch.object(self.server, "_worker_client", client):
            count, _ = self.server.sync_pending_essays()
        self.assertEqual(count, 0)
        self.assertEqual(self.row("essays", fixture_row("essays")["uid"])["synced"], 0)

    def test_all_content_payloads_version_public_and_withdrawal_requests(self):
        self.seed_endpoints()
        functions = {"memories": self.server.sync_public_memory, "anchors": self.server.sync_public_anchor,
                     "essays": self.server.sync_public_essay, "observations": self.server.sync_public_observation,
                     "observation_links": self.server.sync_public_observation_link}
        for table, sender in functions.items():
            with self.subTest(table=table):
                source = dict(fixture_row(table), sync_revision=41)
                with mock.patch.object(self.server._worker_client, "post", return_value=(True, "")) as post:
                    self.assertTrue(sender(source)[0])
                    sent = post.call_args.args[1]
                    self.assertEqual(sent["sync_revision"], 41)
                    if table in ("essays", "observations"):
                        for status in ("draft", "archived"):
                            sender(dict(source, status=status, sync_revision=42))
                            self.assertEqual(post.call_args.args[1], {"uid": source["uid"], "published": False, "sync_revision": 42})
                    elif table == "observation_links":
                        with closing(self.store.connect()) as connection:
                            connection.execute("UPDATE observations SET status='draft' WHERE uid=?", (source["source_uid"],))
                            connection.commit()
                        sender(dict(source, sync_revision=42))
                        self.assertEqual(post.call_args.args[1], {"uid": source["uid"], "published": False, "sync_revision": 42})


if __name__ == "__main__":
    unittest.main(verbosity=2)
