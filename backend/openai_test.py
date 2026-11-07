"""Security and integration tests for the Cloudflare model gateway."""
import io
import json
import os
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from dataclasses import fields
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import flitfancy_http
import flitfancy_openai as gateway
from flitfancy_consultations import ConsultationStore

ADMIN = "fixture-worker-token-0123456789abcdef"
MANAGER = "fixture-cf-manager-token-0123456789"
KEY = "sk-fixture-only-not-a-real-key"
CONFIG = {"worker_admin_url": "https://api.flitfancy.com/", "worker_admin_token": ADMIN}


class Response:
    def __init__(self, body): self.body = json.dumps(body).encode()
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1): return self.body[:size] if size >= 0 else self.body


class Opener:
    def __init__(self, body): self.body = body; self.requests = []
    def open(self, request, timeout=None):
        self.requests.append(request)
        return Response(self.body)


class GatewayTests(unittest.TestCase):
    def test_status_exposes_supported_gateway_capabilities(self):
        capabilities = {"text": True, "multi_turn": True, "streaming": False, "tools": False, "images": False}
        opener = Opener({"ok": True, "configured": True, "interface_version": 1, "capabilities": capabilities, "secret": KEY})
        status = gateway.public_status(CONFIG, opener=opener)
        self.assertEqual(status["interface_version"], 1)
        self.assertEqual(status["capabilities"], capabilities)
        self.assertNotIn(KEY, json.dumps(status))

    def test_daily_limit_sql_is_atomic_under_concurrent_attempts(self):
        source = (Path(__file__).resolve().parent.parent / "cloudflare" / "worker-gpt.js").read_text(encoding="utf-8")
        marker = 'env.DB.prepare("INSERT INTO model_gateway_daily'
        sql = "INSERT INTO model_gateway_daily" + source.split(marker, 1)[1].split('"', 1)[0]
        with tempfile.TemporaryDirectory(prefix="flit-model-limit-") as temporary:
            path = Path(temporary) / "limit.db"
            with closing(sqlite3.connect(path)) as db:
                db.execute("CREATE TABLE model_gateway_daily(day TEXT PRIMARY KEY, requests INTEGER NOT NULL)")
                db.commit()
            def reserve(_):
                with closing(sqlite3.connect(path, timeout=10)) as db:
                    reserved = db.execute(sql, ("2026-11-07", 5)).fetchone() is not None
                    db.commit()
                    return reserved
            with ThreadPoolExecutor(max_workers=12) as pool:
                results = list(pool.map(reserve, range(30)))
            self.assertEqual(sum(results), 5)
            with closing(sqlite3.connect(path)) as db:
                self.assertEqual(db.execute("SELECT requests FROM model_gateway_daily").fetchone()[0], 5)

    def test_configuration_is_forwarded_only_to_expected_worker(self):
        opener = Opener({"ok": True, "configured": True, "provider": "openai", "api_key": KEY, "secret_extra": KEY})
        payload = {"provider": "openai", "model": "gpt-fixture", "base_url": "https://api.openai.com/v1", "api_key": KEY,
                   "access": "admin", "public_daily_limit": 20, "unrelated": "ignored"}
        result = gateway.save_gateway_config(CONFIG, payload, opener=opener)
        request = opener.requests[0]
        self.assertEqual(request.full_url, "https://api.flitfancy.com/admin/model/config")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + ADMIN)
        self.assertIn("Mozilla/5.0", request.get_header("User-agent"))
        self.assertEqual(json.loads(request.data)["api_key"], KEY)
        self.assertNotIn("unrelated", json.loads(request.data))
        self.assertNotIn(KEY, json.dumps(result))
        self.assertNotIn(KEY, json.dumps(CONFIG))
        with self.assertRaises(gateway.OpenAIError):
            gateway.save_gateway_config({**CONFIG, "worker_admin_url": "https://attacker.example"}, payload, opener=opener)
        self.assertEqual(len(opener.requests), 1)
        self.assertIsNone(gateway.NoRedirect().redirect_request(None, None, 302, None, None, "https://attacker.example"))

    def test_bootstrap_only_writes_manager_token_to_fixed_cloudflare_worker(self):
        opener = Opener({"success": True, "result": {"text": MANAGER}})
        self.assertEqual(gateway.bootstrap_secret_manager(MANAGER, opener=opener), {"ok": True})
        request = opener.requests[0]
        self.assertEqual(request.full_url, gateway.CF_SECRET_URL)
        self.assertIn("Mozilla/5.0", request.get_header("User-agent"))
        self.assertEqual(json.loads(request.data), {"name": "CF_SECRET_MANAGER_TOKEN", "text": MANAGER, "type": "secret_text"})
        with self.assertRaises(gateway.OpenAIError): gateway.bootstrap_secret_manager("bad token", opener=opener)

    def test_private_chat_passes_profile_identity_and_returns_sanitized_fields(self):
        opener = Opener({"ok": True, "reply": "合成答复", "model": "fixture", "provider": "openai", "private": KEY})
        result = gateway.ask_openai([{"role": "user", "content": "合成提问"}], CONFIG, purpose="consult",
                                   profile_id="0123456789abcdef", opener=opener)
        self.assertEqual(result["reply"], "合成答复")
        self.assertNotIn(KEY, json.dumps(result))
        payload = json.loads(opener.requests[0].data)
        self.assertEqual(payload["profile_id"], "0123456789abcdef")
        self.assertEqual(payload["purpose"], "consult")

    def test_upstream_error_is_sanitized(self):
        class Failing:
            def open(self, request, timeout=None):
                raise urllib.error.HTTPError(request.full_url, 400, "bad", {}, io.BytesIO(json.dumps({"error": KEY, "code": "invalid_key"}).encode()))
        with self.assertRaises(gateway.OpenAIError) as caught:
            gateway.save_gateway_config(CONFIG, {}, opener=Failing())
        self.assertEqual(caught.exception.code, "invalid_key")
        self.assertNotIn(KEY, str(caught.exception))


class Domain:
    def __getattr__(self, name): raise AssertionError("unexpected access to " + name)


class HttpTests(unittest.TestCase):
    def test_private_endpoints_and_consultation_history(self):
        with tempfile.TemporaryDirectory(prefix="flit-gateway-http-") as temporary:
            root = Path(temporary)
            config = dict(CONFIG)
            deps = {field.name: lambda *args, **kwargs: None for field in fields(flitfancy_http.HttpDependencies)}
            for name in ("audio_service", "sensor_device_service", "activity_service", "bridge_service", "launcher_service", "collector_service", "observation_service", "essay_service", "resource_service", "worker_client", "ai_opener"):
                deps[name] = Domain()
            deps.update(read_local_config=lambda: config, ai_config_save=lambda updates: config.update(updates),
                        db=lambda: sqlite3.connect(root / "test.db"), consultation_service=ConsultationStore(root / "consult.db"),
                        admin_token_valid=lambda token, ip: token == "fixture-admin", cst=timezone(timedelta(hours=8)),
                        cfg_bool=lambda value, default: default if value is None else bool(value),
                        site_root="", mime={}, memories_select="*", sensor_retention_days=14)
            handler = flitfancy_http.create_handler(flitfancy_http.HttpDependencies(**deps))
            handler.log_message = lambda *args: None
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(path, method="GET", body=None, auth=False, extra=None):
                headers = {"Content-Type": "application/json", **(extra or {})}
                if auth: headers["Authorization"] = "Bearer fixture-admin"
                request = urllib.request.Request("http://127.0.0.1:%d%s" % (server.server_port, path),
                    data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
                try: response = urllib.request.urlopen(request, timeout=3)
                except urllib.error.HTTPError as error: response = error
                with response: return response.status, json.loads(response.read())
            try:
                for path in ("/api/model-gateway/status", "/api/consultations"):
                    self.assertEqual(request(path)[0], 401)
                for path in ("/api/model-gateway/config", "/api/model-gateway/chat", "/api/model-gateway/cloudflare-token"):
                    self.assertEqual(request(path, "POST")[0], 401)
                self.assertEqual(request("/api/model-gateway/config", "POST", auth=True, extra={"Sec-Fetch-Site": "cross-site"})[0], 403)
                store = deps["consultation_service"]
                ident = store.record("question", "实际问题", provider="OpenAI", model="fixture")
                store.record("answer", "模型原文", consultation_id=ident, provider="OpenAI", model="fixture")
                status, trace = request("/api/consultations?after=0", auth=True)
                self.assertEqual((status, [row["content"] for row in trace["events"]]), (200, ["实际问题", "模型原文"]))
                with patch.object(flitfancy_http, "save_gateway_config", return_value={"configured": True}) as save:
                    status, body = request("/api/model-gateway/config", "POST", {"api_key": KEY}, True)
                self.assertEqual(status, 200)
                self.assertNotIn(KEY, json.dumps(body))
                self.assertEqual(save.call_args.args[1]["api_key"], KEY)
                self.assertNotIn(KEY, json.dumps(config), "model key must never be written into local config")
                with patch.object(flitfancy_http, "bootstrap_secret_manager", return_value={"ok": True}) as bootstrap:
                    status, body = request("/api/model-gateway/cloudflare-token", "POST", {"token": MANAGER}, True)
                self.assertEqual((status, body), (200, {"ok": True}))
                bootstrap.assert_called_once_with(MANAGER)
                self.assertNotIn(MANAGER, json.dumps(config))
                with patch.object(flitfancy_http, "ask_openai", return_value={"reply": "收到"}) as ask:
                    status, body = request("/api/model-gateway/chat", "POST", {"messages": [{"role": "user", "content": "你好"}], "profile_id": "fixture"}, True)
                self.assertEqual((status, body["reply"]), (200, "收到"))
                self.assertEqual(ask.call_args.kwargs["profile_id"], "fixture")
            finally:
                server.shutdown(); server.server_close(); thread.join(3)


if __name__ == "__main__": unittest.main(verbosity=2)
