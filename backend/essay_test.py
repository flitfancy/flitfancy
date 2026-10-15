"""短文业务与 HTTP 委托回归；仅使用临时数据库和内存配置。"""

import json
import tempfile
import unittest
from contextlib import closing
from dataclasses import fields
from pathlib import Path

from flitfancy_essays import BUILTIN_PROLOGUE_UID, EssayService
from flitfancy_http import HttpDependencies, create_handler
from flitfancy_storage import SQLiteStore


STAMP = "2026-10-15T12:00:00+08:00"


class EssayServiceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="flitfancy-essay-test-")
        self.addCleanup(temporary.cleanup)
        self.store = SQLiteStore(str(Path(temporary.name) / "test.db"))
        self.store.initialize()
        self.config = {}
        self.config_deliveries = []
        self.online = False

        def sync_essays():
            if not self.online:
                return 0, "fixture offline"
            rows = self.store.pending_rows("essays", 200)
            for row in rows:
                self.store.mark_synced("essays", row["uid"], row["sync_revision"])
            return len(rows), ""

        def sync_config(updates):
            self.config_deliveries.append(updates)
            return self.online, "" if self.online else "fixture offline"

        self.service = EssayService(
            self.store.connect, lambda: STAMP, lambda: self.config, self.config.update,
            sync_essays, sync_config,
        )

    def save(self, **updates):
        status, result = self.service.save_essay({"title": "测试短文", "content": "测试正文", **updates})
        self.assertIn(status, (200, 201), result)
        return result

    def row(self, uid):
        with closing(self.store.connect()) as con:
            return dict(con.execute("SELECT * FROM essays WHERE uid=?", (uid,)).fetchone())

    def test_validation_uses_existing_contract_and_preserves_failed_edits(self):
        contract_path = Path(__file__).parent.parent / "tests/contracts/essays.json"
        for case in json.loads(contract_path.read_text(encoding="utf-8"))["cases"]:
            with self.subTest(case=case["name"]):
                status, result = self.service.save_essay(case["payload"])
                self.assertEqual(status in (200, 201), case["valid"], result)
        status, _ = self.service.save_essay({"uid": "missing-essay-0001", "title": "缺失", "content": "正文"})
        self.assertEqual(status, 404)
        saved = self.save()["essay"]
        before = self.row(saved["uid"])
        for updates in ({"title": ""}, {"content": ""}, {"status": "unknown"},
                        {"title": "x" * 121}, {"content": "x" * 12001}):
            with self.subTest(updates=next(iter(updates))):
                status, _ = self.service.save_essay({**saved, **updates})
                self.assertEqual(status, 400)
                self.assertEqual(self.row(saved["uid"]), before)

    def test_public_and_admin_catalogs_keep_visibility_order_and_field_boundaries(self):
        draft = self.save(status="draft", display_order=0)["essay"]
        archived = self.save(status="archived", display_order=0)["essay"]
        later = self.save(status="public", display_order=20)["essay"]
        first = self.save(status="public", display_order=10)["essay"]
        public = self.service.public_catalog()["rows"]
        self.assertEqual([row["uid"] for row in public], [first["uid"], later["uid"]])
        self.assertTrue(all("status" not in row and "synced" not in row for row in public))
        admin = self.service.admin_catalog()
        self.assertEqual([row["uid"] for row in admin["rows"]],
                         [first["uid"], later["uid"], draft["uid"], archived["uid"]])
        self.assertIsNone(admin["featured_essay"])

    def test_offline_save_is_durable_and_edits_keep_version_acknowledgements(self):
        initial = self.save(status="public", display_order=-4)
        self.assertFalse(initial["public_sync"])
        self.assertEqual(initial["public_sync_note"], "fixture offline")
        original = self.row(initial["essay"]["uid"])
        self.assertEqual(original["display_order"], 0)
        self.assertEqual(original["synced"], 0)
        self.online = True
        edited = self.save(uid=original["uid"], content="更新的正文", status="public", display_order=10001)
        self.assertTrue(edited["updated"])
        self.assertTrue(edited["public_sync"])
        current = self.row(original["uid"])
        self.assertEqual(current["created_at"], original["created_at"])
        self.assertGreater(current["sync_revision"], original["sync_revision"])
        self.assertEqual(current["display_order"], 9999)
        self.assertEqual(len(self.service.admin_catalog()["rows"]), 1)

    def test_feature_selection_requires_public_essay_and_keeps_a_frozen_snapshot(self):
        self.assertEqual(self.service.feature_essay({"uid": "missing-essay-0001"})[0], 404)
        draft = self.save()["essay"]
        self.assertEqual(self.service.feature_essay({"uid": draft["uid"]})[0], 400)
        public = self.save(uid=draft["uid"], status="public")["essay"]
        status, selected = self.service.feature_essay({"uid": public["uid"]})
        self.assertEqual(status, 200)
        self.assertFalse(selected["public_sync"])
        self.assertEqual(self.config_deliveries, [{"featured_essay": selected["essay"]}])
        self.assertEqual(set(selected["essay"]), {"uid", "title", "content", "updated_at"})
        self.save(uid=public["uid"], status="public", content="仅更新卡牌正文")
        self.assertEqual(self.service.featured_snapshot()["essay"]["content"], public["content"])
        self.online = True
        status, refreshed = self.service.feature_essay({"uid": public["uid"]})
        self.assertEqual(status, 200)
        self.assertTrue(refreshed["public_sync"])
        self.assertEqual(refreshed["essay"]["content"], "仅更新卡牌正文")

    def test_featured_card_cannot_be_withdrawn_until_another_card_is_selected(self):
        first = self.save(status="public")["essay"]
        second = self.save(status="public")["essay"]
        self.service.feature_essay({"uid": first["uid"]})
        for status in ("draft", "archived"):
            self.assertEqual(self.service.save_essay({**first, "status": status})[0], 409)
            self.assertEqual(self.row(first["uid"])["status"], "public")
        snapshot = self.config["featured_essay"]
        self.service.feature_essay({"uid": second["uid"]})
        self.save(**{**first, "status": "archived"})
        # A stale selection from another caller must not expose a withdrawn body.
        self.config["featured_essay"] = snapshot
        self.assertIsNone(self.service.featured_snapshot()["essay"])

    def test_builtin_prologue_is_idempotent_and_keeps_default_archive_guard(self):
        payload = {"uid": BUILTIN_PROLOGUE_UID, "title": "序章", "content": "原稿"}
        self.assertEqual(self.service.save_essay({**payload, "status": "archived"})[0], 409)
        self.save(**payload)
        first = self.row(BUILTIN_PROLOGUE_UID)
        self.save(**{**payload, "content": "原稿更新", "status": "public"})
        second = self.row(BUILTIN_PROLOGUE_UID)
        self.assertEqual(len(self.service.admin_catalog()["rows"]), 1)
        self.assertGreater(second["sync_revision"], first["sync_revision"])


class EssayHttpAdapterTest(unittest.TestCase):
    def test_all_essay_routes_delegate_without_accessing_storage_or_config(self):
        calls = []
        marker = {"ok": True, "fixture": "service response"}

        class Service:
            def __getattr__(self, name):
                def invoke(*args):
                    calls.append((name, args))
                    return (409, marker) if args else marker
                return invoke

        def forbidden(*_args, **_kwargs):
            raise AssertionError("HTTP adapter must not implement essay business rules")

        deps = {field.name: forbidden for field in fields(HttpDependencies)}
        deps["essay_service"] = Service()
        handler = object.__new__(create_handler(HttpDependencies(**deps)))
        responses = []
        handler._send = lambda status, payload: responses.append((status, payload))
        for path, method in (("/api/essays", "public_catalog"),
                             ("/api/admin/essays", "admin_catalog"),
                             ("/api/essays/featured", "featured_snapshot")):
            handler._api_get(path)
            self.assertEqual(calls[-1], (method, ()))
            self.assertEqual(responses[-1], (200, marker))
        data = {"uid": "fixture-essay-0001", "title": "测试"}
        handler._json_body = lambda: data
        for name, method in (("_api_essay_create", "save_essay"), ("_api_essay_feature", "feature_essay")):
            getattr(handler, name)()
            self.assertEqual(calls[-1], (method, (data,)))
            self.assertEqual(responses[-1], (409, marker))
        before = len(calls)
        handler._json_body = lambda: None
        handler._api_essay_create()
        handler._api_essay_feature()
        self.assertEqual(len(calls), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
