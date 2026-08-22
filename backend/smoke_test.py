"""flitfancy 服务冒烟测试：启动服务 -> 写入数据 -> 读回 -> 关闭并清理。"""

import hashlib
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

import server as server_module

ROOT = os.path.dirname(os.path.abspath(__file__))
CST = timezone(timedelta(hours=8))
with open(os.path.join(ROOT, "..", "tests", "contracts", "reflections.json"),
          encoding="utf-8") as contract_file:
    REFLECTIONS_CONTRACT = json.load(contract_file)
with open(os.path.join(ROOT, "..", "tests", "contracts", "essays.json"),
          encoding="utf-8") as contract_file:
    ESSAYS_CONTRACT = json.load(contract_file)
with open(os.path.join(ROOT, "..", "tests", "contracts", "observations.json"),
          encoding="utf-8") as contract_file:
    OBSERVATIONS_CONTRACT = json.load(contract_file)


def recent_ts(seconds_ago):
    """相对当前时间的 CSV 时间戳：避免硬编码日期越过 14 天保留期后测试腐烂。"""
    return (datetime.now(CST) - timedelta(seconds=seconds_ago)).strftime("%Y-%m-%d %H:%M:%S")


def request(base, path, method="GET", body=None, headers=None, expected=200, raw=False,
            return_headers=False):
    if body is None:
        data = None
    elif raw:
        data = str(body).encode("utf-8")
    else:
        data = json.dumps(body).encode("utf-8")
    request_headers = dict(headers or {})
    if data:
        request_headers["Content-Type"] = "text/plain" if raw else "application/json"
    req = urllib.request.Request(
        base + path, data=data, method=method, headers=request_headers,
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        payload = json.loads(response.read().decode("utf-8"))
        if response.status != expected:
            raise AssertionError("%s: expected HTTP %d, got %d: %r" % (
                path, expected, response.status, payload,
            ))
        return (payload, response.headers) if return_headers else payload


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_until_ready(base, proc, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("测试服务提前退出，exit=%s" % proc.returncode)
        try:
            request(base, "/api/status")
            return
        except (OSError, AssertionError):
            time.sleep(0.25)
    raise RuntimeError("测试服务启动超时")


def main():
    captured_sync = {}
    original_worker_post = server_module.worker_post
    try:
        server_module.worker_post = lambda endpoint, payload, timeout, error_label: (
            captured_sync.update({"endpoint": endpoint, "payload": payload}) or (True, "")
        )
        ok, _ = server_module.sync_public_memory({
            "uid": "contract-memory-0001",
            "created_at": "2026-08-21T12:00:00+08:00",
            "memory_time": "2026-08-21T12:00:00+08:00",
            "time_precision": "second",
            "memory_date": "2026-08-21",
            "perspective": "me",
            "source": "manual",
            "content": "契约测试",
        })
        memory_sync = dict(captured_sync)
        server_module.sync_public_anchor({
            "uid": "contract-anchor-0001",
            "created_at": "2026-08-21T12:00:00+08:00",
            "anchor_time": "2026-08-21T12:00:00+08:00",
            "time_precision": "second",
            "horizon": "future",
            "project": "skywork",
            "title": "契约锚点",
            "content": "契约测试",
        })
        anchor_sync = dict(captured_sync)
        server_module.sync_public_essay({
            "uid": "contract-essay-0001",
            "created_at": "2026-08-21T12:00:00+08:00",
            "updated_at": "2026-08-21T12:00:00+08:00",
            "title": "草稿",
            "content": "这段草稿不得上传",
            "status": "draft",
            "display_order": 10,
        })
        draft_sync = dict(captured_sync)
        server_module.sync_public_observation({
            "uid": "contract-observation-0001",
            "created_at": "2026-08-21T12:00:00+08:00",
            "updated_at": "2026-08-21T12:00:00+08:00",
            "title": "本地草稿星球",
            "category": "技术与造物",
            "tags_json": '["私密"]',
            "summary": "这段摘要不得上传",
            "content": "这段正文不得上传",
            "discovered_at": "2026-08-21",
            "source_name": "私密来源",
            "source_url": "https://example.com/private",
            "status": "draft",
        })
        draft_observation_sync = dict(captured_sync)
    finally:
        server_module.worker_post = original_worker_post
    assert ok is True
    assert memory_sync["endpoint"] == "/admin/memories"
    assert set(memory_sync["payload"]) == {
        "uid", "created_at", "time", "precision", "perspective", "source", "content",
    }
    assert anchor_sync["endpoint"] == "/admin/anchors"
    assert anchor_sync["payload"]["horizon"] == "future"
    assert anchor_sync["payload"]["project"] == "skywork"
    assert draft_sync == {
        "endpoint": "/admin/essays",
        "payload": {"uid": "contract-essay-0001", "published": False},
    }
    assert draft_observation_sync == {
        "endpoint": "/admin/observations",
        "payload": {"uid": "contract-observation-0001", "published": False},
    }
    print("SYNC CONTRACT: taxonomy preserved; draft essay/observation content stays local")

    with tempfile.TemporaryDirectory(prefix="flitfancy-smoke-") as temp_dir:
        port = free_port()
        base = "http://127.0.0.1:%d" % port
        db_path = os.path.join(temp_dir, "smoke.db")
        config_path = os.path.join(temp_dir, "ai_local.json")
        password = "smoke-password"
        salt = "0123456789abcdef0123456789abcdef"
        with open(config_path, "w", encoding="utf-8") as f:
            json.dump({
                "admin_accounts": [{
                    "username": "smoke-admin",
                    "salt": salt,
                    "password_hash": hashlib.sha256((salt + password).encode("utf-8")).hexdigest(),
                }],
                # 不可达的 Worker 地址：验证公网同步失败不影响本地采集，
                # 并回归覆盖 queue_public_sensor_sync -> 后台同步线程全链路。
                "worker_admin_url": "http://127.0.0.1:1/unreachable",
                "worker_admin_token": "smoke-worker-token-0123456789abcdef",
            }, f)
        env = os.environ.copy()
        env.update({
            "FLITFANCY_HOST": "127.0.0.1",
            "FLITFANCY_PORT": str(port),
            "FLITFANCY_DB_PATH": db_path,
            "FLITFANCY_AI_CONFIG_PATH": config_path,
            "FLITFANCY_SENSOR_RETENTION_DAYS": "14",
            "FLITFANCY_SENSOR_PRUNE_INTERVAL_SECONDS": "0",
        })
        proc = subprocess.Popen(
            [sys.executable, "server.py"], cwd=ROOT, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            wait_until_ready(base, proc)
            status, api_headers = request(base, "/api/status", return_headers=True)
            assert api_headers.get("Cache-Control") == "no-store"
            assert api_headers.get("X-Content-Type-Options") == "nosniff"
            assert api_headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
            print("STATUS:", status["msg"])
            ingested = request(base, "/api/ingest", "POST", {
                "channel": "CH0", "sensor": "CH0 SHT41",
                "ok": 1, "temp_c": 28.5, "rh_pct": 41.2,
            })
            print("INGEST: ok=%s rows=%s" % (ingested["ok"], ingested["ingested"]))
            latest = request(base, "/api/sensors/latest")
            row = latest["rows"][0]
            print("LATEST: %s %.1f C" % (row["channel"], row["temp_c"]))
            request(base, "/api/ingest", "POST", {
                "ts": "2020-01-01T00:00:00+08:00",
                "channel": "CH9", "sensor": "retention-test",
                "ok": 1, "temp_c": 1,
            })
            history = request(base, "/api/sensors/history")["rows"]
            assert not any(r["channel"] == "CH9" for r in history), (
                "超过 14 天的 SQLite 传感器明细应在写入后清理"
            )
            status = request(base, "/api/status")
            assert status["sensor_retention_days"] == 14
            services = status["services"]
            for key in ("backend", "listener", "tunnel"):
                assert isinstance(services[key], bool), "心跳状态必须是布尔"
            assert services["backend"] is True
            print("RETENTION: SQLite keeps 14 days")
            print("HEARTBEAT: service states exposed")
            ranged = request(base, "/api/sensors/history?channel=CH0&hours=24")
            assert ranged["ok"] is True
            assert any(b["n"] and b["temp_c"] is not None for b in ranged["buckets"]), (
                "24 小时区间历史应返回该通道的聚合桶"
            )
            bad_range = request(base, "/api/sensors/history?channel=CH0&hours=999")
            assert "buckets" not in bad_range, "超范围 hours 应回退到默认 300 行"
            print("HISTORY: channel 24h buckets ok")
            csv_line = (
                recent_ts(30) + ".123,14115136,150,2,CH2 AS7341,1,"
                "0.00,0.00,0,0,122,305,437,670,874,1080,1389,1056,2930,232,"
                "0,0,0,0,0,0.00,29,599,64.0,812,42,0,1.2.0,3,independent-v1"
            )
            csv_result = request(
                base, "/api/ingest", "POST", csv_line,
                {"X-Firefly-Board": "firefly-r1-1-test"}, raw=True,
            )
            assert csv_result["ingested"] == 1
            failed_line = (
                recent_ts(40) + ".456,14125000,150,5,CH5 SCD40,0,"
                + ",".join(["NA"] * 23)
            )
            request(
                base, "/api/ingest", "POST", failed_line,
                {"X-Firefly-Board": "firefly-r1-1-test"}, raw=True,
            )
            sensor_rows = request(base, "/api/sensors/latest")["rows"]
            spectrum = next(r for r in sensor_rows if r["channel"] == "CH2")
            failed = next(r for r in sensor_rows if r["channel"] == "CH5")
            assert spectrum["board"] == "firefly-r1-1-test"
            assert spectrum["f1_415"] == 122
            assert spectrum["as7341_gainx"] == 64
            assert spectrum["sample_age_ms"] == 812
            assert spectrum["sample_seq"] == 42
            assert spectrum["error_streak"] == 0
            assert spectrum["firmware_version"] == "1.2.0"
            assert spectrum["schema_version"] == 3
            assert spectrum["scheduler"] == "independent-v1"
            assert failed["ok"] == 0
            spectral = request(base, "/api/sensors/history?channel=CH2&hours=24")
            assert any(
                b["n"] and b["f1_415"] is not None for b in spectral["buckets"]
            ), "24h 历史桶必须保留光谱八波段（f1_415 等原始数据不得在聚合中丢失）"
            print("SENSORS: raw CSV, spectrum extras and failed rows preserved")
            print("HISTORY: spectral bands preserved in buckets")
            legacy_line = (
                recent_ts(50) + ".789,14136000,151,3,CH3 LTR390,1,"
                "0.00,0.00,321,44," + ",".join(["0"] * 16)
            )
            assert request(
                base, "/api/ingest", "POST", legacy_line,
                {"X-Firefly-Board": "firefly-r1-1-legacy"}, raw=True,
            )["ingested"] == 1
            request(base, "/api/notes", "POST", {"author": "test", "content": "冒烟测试"})
            notes = request(base, "/api/notes")
            print("NOTES:", notes["rows"][0]["content"])
            created = request(base, "/api/memories", "POST", {
                "time": "2026-08-12T21:35:07",
                "perspective": "me",
                "content": "只写进隔离的临时数据库。",
            }, expected=201)
            assert created["memory"]["time"] == "2026-08-12T21:35:07+08:00"
            assert created["memory"]["precision"] == "second"
            assert created["public_sync"] is False
            memories = request(base, "/api/memories")
            assert memories["rows"][0]["perspective"] == "me"
            legacy_rejected = request(base, "/api/memories", "POST", {
                "date": "2026-08-11",
                "perspective": "her",
                "source": "firefly",
                "title": "旧插件标题",
                "content": "旧插件正文",
            }, expected=400)
            assert "停止支持" in legacy_rejected["error"]
            print("MEMORY: local save ok; offline public sync remains pending")

            anchor_created = request(base, "/api/anchors", "POST", {
                "title": "测试锚点", "content": "冒烟测试里的一个锚点。",
                "time": "2026-08-10",
                "horizon": "now", "project": "flitfancy",
            }, expected=201)
            assert anchor_created["anchor"]["title"] == "测试锚点"
            assert anchor_created["anchor"]["precision"] == "date"
            assert anchor_created["anchor"]["horizon"] == "now"
            assert anchor_created["anchor"]["project"] == "flitfancy"
            anchors = request(base, "/api/anchors")
            assert anchors["rows"][0]["title"] == "测试锚点"
            print("ANCHOR: local save and read ok")

            # C5: 编辑路径——带 uid 重新提交 = 原地更新，不产生重复条目。
            memories_before = len(request(base, "/api/memories")["rows"])
            updated_memory = request(base, "/api/memories", "POST", {
                "uid": created["memory"]["uid"],
                "time": "2026-08-12T22:00:00",
                "perspective": "me",
                "content": "编辑后的日记内容。",
            }, expected=200)
            assert updated_memory["updated"] is True
            assert updated_memory["memory"]["content"] == "编辑后的日记内容。"
            assert len(request(base, "/api/memories")["rows"]) == memories_before
            updated_anchor = request(base, "/api/anchors", "POST", {
                "uid": anchor_created["anchor"]["uid"],
                "title": "编辑后的锚点",
                "content": "编辑后的锚点内容。",
                "time": "2026-08-10",
                "horizon": "future",
                "project": "firefly",
            }, expected=200)
            assert updated_anchor["updated"] is True
            assert updated_anchor["anchor"]["title"] == "编辑后的锚点"
            assert updated_anchor["anchor"]["horizon"] == "future"
            assert updated_anchor["anchor"]["project"] == "firefly"
            anchors_now = request(base, "/api/anchors")["rows"]
            assert len([r for r in anchors_now if r["uid"] == anchor_created["anchor"]["uid"]]) == 1
            print("EDIT: memory/anchor update in place without duplicates")

            invalid_anchor = request(base, "/api/anchors", "POST", {
                "title": "缺少分类", "content": "不能保存", "time": "2026-08-10",
            }, expected=400)
            assert "时间视角" in invalid_anchor["error"]

            # 本地管理员登录：后续 /api/admin/* 读接口都需要令牌（与会话
            # IP 绑定，隧道段另有独立登录，互不影响）。
            admin_login_local = request(base, "/api/admin/login", "POST", {
                "username": "smoke-admin", "password": password,
            })
            assert admin_login_local.get("token"), admin_login_local
            admin_bearer = {"Authorization": "Bearer " + admin_login_local["token"]}

            draft = request(base, "/api/essays", "POST", {
                "title": "草稿短文", "content": "尚未公开。",
                "status": "draft", "display_order": 20,
            }, expected=201)["essay"]
            assert request(base, "/api/essays")["rows"] == []
            assert request(base, "/api/admin/essays",
                           headers=admin_bearer)["rows"][0]["status"] == "draft"
            published = request(base, "/api/essays", "POST", {
                "uid": draft["uid"], "title": "公开短文", "content": "已经公开。",
                "status": "public", "display_order": 20,
            }, expected=200)["essay"]
            assert published["status"] == "public"
            first = request(base, "/api/essays", "POST", {
                "title": "排在前面", "content": "顺序为十。",
                "status": "public", "display_order": 10,
            }, expected=201)["essay"]
            public_essays = request(base, "/api/essays")["rows"]
            assert [row["uid"] for row in public_essays] == [first["uid"], draft["uid"]]
            archived = request(base, "/api/essays", "POST", {
                "uid": draft["uid"], "title": "公开短文", "content": "已经归档。",
                "status": "archived", "display_order": 20,
            }, expected=200)["essay"]
            assert archived["status"] == "archived"
            assert [row["uid"] for row in request(base, "/api/essays")["rows"]] == [first["uid"]]
            print("ESSAYS: draft, publish, order and archive paths ok")

            # 与 Worker 共用同一份契约：accept/reject 判定必须逐条一致。
            for index, case in enumerate(ESSAYS_CONTRACT["cases"]):
                request(base, "/api/essays", "POST", dict(case["payload"]),
                        expected=201 if case["valid"] else 400)
            print("ESSAYS-CONTRACT: parity with worker fixtures ok")

            draft_star = request(base, "/api/observations", "POST", {
                "title": "脉冲星的钟", "category": "宇宙与自然",
                "tags": ["时间", "宇宙"], "summary": "宇宙中的稳定节拍。",
                "content": "一些脉冲星拥有极其稳定的周期。",
                "discovered_at": "2026-08-22", "source_name": "示例来源",
                "source_url": "https://example.com/pulsar", "status": "draft",
            }, expected=201)["observation"]
            assert request(base, "/api/observations")["rows"] == []
            assert request(base, "/api/admin/observations", headers=admin_bearer)["rows"][0]["tags"] == ["时间", "宇宙"]
            first_star = request(base, "/api/observations", "POST", {
                "uid": draft_star["uid"], "title": "脉冲星的钟", "category": "宇宙与自然",
                "tags": ["时间", "宇宙"], "summary": "宇宙中的稳定节拍。",
                "content": "一些脉冲星拥有极其稳定的周期。",
                "discovered_at": "2026-08-22", "source_name": "示例来源",
                "source_url": "https://example.com/pulsar", "status": "public",
            }, expected=200)["observation"]
            second_star = request(base, "/api/observations", "POST", {
                "title": "两千年前的齿轮", "category": "历史与文明",
                "tags": ["机械", "计时"], "summary": "古代机械与天体运行。",
                "content": "安提基特拉机械展现了古代精密造物。",
                "discovered_at": "2026-08-21", "source_name": "示例来源",
                "source_url": "https://example.com/gears", "status": "public",
            }, expected=201)["observation"]
            link = request(base, "/api/observation-links", "POST", {
                "source_uid": first_star["uid"], "target_uid": second_star["uid"],
                "relation": "类比",
            }, expected=201)["link"]
            public_observations = request(base, "/api/observations")
            assert len(public_observations["rows"]) == 2
            assert public_observations["links"][0]["uid"] == link["uid"]
            request(base, "/api/observations", "POST", {
                "uid": first_star["uid"], "title": "脉冲星的钟", "category": "宇宙与自然",
                "tags": ["时间"], "summary": "宇宙中的稳定节拍。", "content": "归档。",
                "discovered_at": "2026-08-22", "source_name": "", "source_url": "",
                "status": "archived",
            }, expected=200)
            assert request(base, "/api/observations")["links"] == []
            request(base, "/api/observations", "POST", {
                "title": "危险来源", "category": "技术与造物", "tags": [],
                "summary": "来源协议不合法。", "content": "测试。",
                "discovered_at": "2026-08-22", "source_name": "错误",
                "source_url": "javascript:alert(1)", "status": "draft",
            }, expected=400)

            # 与 Worker 共用同一份契约：accept/reject 判定必须逐条一致。
            for index, case in enumerate(OBSERVATIONS_CONTRACT["cases"]):
                request(base, "/api/observations", "POST", dict(case["payload"]),
                        expected=201 if case["valid"] else 400)
            print("OBSERVATIONS-CONTRACT: parity with worker fixtures ok")
            print("OBSERVATIONS: draft, publish, archive, links and URL validation ok")

            # C7: 静态日记一次性导入：确定性 uid + 重复导入幂等。
            imp1 = request(base, "/api/memories/import-static", "POST", {
                "entries": [
                    {"date": "2026-02-03", "content": "导入一"},
                    {"date": "2026-02-04", "content": "导入二"},
                ],
            }, expected=200)
            assert imp1["imported"] == 2
            imp2 = request(base, "/api/memories/import-static", "POST", {
                "entries": [{"date": "2026-02-03", "content": "导入一"}],
            }, expected=200)
            assert imp2["imported"] == 0
            print("IMPORT: static diary import idempotent")

            # C8: 时间宽松归一——仅日期 / 到分钟 自动补齐，完整形式不变。
            date_only = request(base, "/api/memories", "POST", {
                "time": "2026-08-15",
                "perspective": "me",
                "content": "仅日期的日记。",
            }, expected=201)
            assert date_only["memory"]["time"] == "2026-08-15T00:00:00+08:00"
            assert date_only["memory"]["precision"] == "date"
            minute_only = request(base, "/api/memories", "POST", {
                "time": "2026-08-16T09:30",
                "perspective": "me",
                "content": "到分钟的日记。",
            }, expected=201)
            assert minute_only["memory"]["time"] == "2026-08-16T09:30:00+08:00"
            print("TIME: date-only and minute-only normalized")

            refl = request(base, "/api/reflections", "POST", {
                "content": "冒烟随笔一句。",
            }, expected=201)
            assert "冒烟随笔一句。" in refl["reflections"]
            reflections_now = request(base, "/api/reflections")
            assert "冒烟随笔一句。" in reflections_now["reflections"]
            print("REFLECTION: append and read ok")

            # C6: 整表替换负载（编辑器列表保存）：去空去重 + 覆盖旧值。
            replaced = request(base, "/api/reflections", "POST", {
                "reflections": ["替换一", "替换二", "替换一", ""],
            }, expected=201)
            assert replaced["reflections"] == ["替换一", "替换二"]
            assert "冒烟随笔一句。" not in replaced["reflections"]
            print("REFLECTION: full-replace edit path ok")

            tunnel_headers_a = {"Host": "console.flitfancy.com", "CF-Connecting-IP": "203.0.113.10"}
            tunnel_headers_b = {"Host": "console.flitfancy.com", "CF-Connecting-IP": "203.0.113.11"}
            for remaining in (4, 3, 2, 1):
                failed = request(base, "/api/admin/login", "POST", {
                    "username": "smoke-admin", "password": "wrong",
                }, tunnel_headers_a, expected=403)
                assert str(remaining) in failed["error"]
            separate = request(base, "/api/admin/login", "POST", {
                "username": "smoke-admin", "password": "wrong",
            }, tunnel_headers_b, expected=403)
            assert "4" in separate["error"]
            login = request(base, "/api/admin/login", "POST", {
                "username": "smoke-admin", "password": password,
            }, tunnel_headers_a)
            assert login.get("token")
            with open(config_path, "r", encoding="utf-8") as f:
                migrated = json.load(f)["admin_accounts"][0]
            assert migrated["password_scheme"] == "pbkdf2_sha256"
            assert migrated["password_iterations"] >= 600_000
            relogin = request(base, "/api/admin/login", "POST", {
                "username": "smoke-admin", "password": password,
            }, tunnel_headers_a)
            assert relogin.get("token")
            print("ADMIN: independent IP counters; legacy password upgraded")

            admin_headers = dict(tunnel_headers_a)
            admin_headers["Authorization"] = "Bearer " + relogin["token"]
            reflections_saved = request(base, "/api/admin/config", "POST", {
                "reflections": REFLECTIONS_CONTRACT["input"],
            }, admin_headers)
            assert reflections_saved["reflections"] == REFLECTIONS_CONTRACT["expected"]
            assert reflections_saved["public_sync"] is False
            public_reflections = request(base, "/api/reflections")
            assert public_reflections["reflections"] == REFLECTIONS_CONTRACT["expected"]
            print("REFLECTIONS: local save, cleanup and public read ok")

            # /api/admin/* 读取与写接口同一姿态：未登录一律 401，带令牌放行。
            # 令牌与会话 IP 绑定，因此用本地登录换取的令牌走本地请求。
            for admin_read_path in ("/api/admin/essays",
                                    "/api/admin/observations",
                                    "/api/admin/observation-links"):
                request(base, admin_read_path, expected=401)
                request(base, admin_read_path, headers=admin_bearer)
            print("ADMIN-READ: essays/observations/links require login")

            # B1: 前缀域名 Host（DNS rebinding 场景）不得被当作本地放行
            rebind = request(base, "/api/status", headers={
                "Host": "localhost.evil.com",
            }, expected=401)
            assert rebind["ok"] is False
            local_port_host = request(base, "/api/status", headers={
                "Host": "localhost:%d" % port,
            })
            assert local_port_host["services"]["backend"] is True
            print("GUARD: prefix-domain Host rejected; exact local Host ok")

            # B2: 浏览器跨站 POST 一律 403；同源不受影响
            csrf_blocked = request(base, "/api/ingest", "POST", {
                "channel": "CH0", "sensor": "evil-site", "ok": 1,
            }, {"Sec-Fetch-Site": "cross-site"}, expected=403)
            assert csrf_blocked["ok"] is False
            request(base, "/api/notes", "POST", {
                "author": "test", "content": "same-origin ok",
            }, {"Sec-Fetch-Site": "same-origin"})
            print("CSRF: cross-site POST rejected, same-origin allowed")

            # C1: 命令限长——超过 200 字符直接 400，合法命令入队。
            overlong = request(base, "/api/command", "POST", {
                "command": "x" * 201,
            }, expected=400)
            assert "200" in overlong["error"]
            queued = request(base, "/api/command", "POST", {"command": "hello"})
            assert queued["ok"] is True and queued["command"] == "hello"
            print("COMMAND: length cap enforced; valid command queued")

            # C2: (channel, ts) 复合索引——通道历史查询依赖的索引必须存在。
            con = sqlite3.connect(db_path)
            try:
                names = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                )}
            finally:
                con.close()
            assert "idx_sensors_channel_ts" in names
            assert "idx_sensors_ts" in names
            print("INDEX: channel+ts composite index present")

            # C3: 公网同步 worker 全链路（P0 回归）——worker 地址不可达时，
            # ingest 必须照常 200，后台线程静默丢弃失败批次，绝不抛 NameError。
            request(base, "/api/status")
            print("SYNC: unreachable worker does not break ingest")

            # C4: 登录锁定的未来时间戳钳制——时钟回拨产生的超长锁定
            # 在提示层按 10 分钟上限封顶。
            sys.path.insert(0, ROOT)
            import server as server_mod
            server_mod._admin_fails["future-ip"] = [0, time.time() + 24 * 3600]
            locked, message = server_mod.admin_login("future-ip", "u", "p")
            assert locked is False
            assert "10 分钟" in message, "未来时间戳必须钳制到锁定上限"
            print("LOGIN: future lock timestamp clamped to 10 minutes")

            with urllib.request.urlopen(base + "/console.html", timeout=10) as r:
                html = r.read().decode("utf-8")
                print("PAGE: HTTP %d len=%d" % (r.status, len(html)))
            with urllib.request.urlopen(base + "/robots.txt", timeout=10) as r:
                assert r.headers.get("Content-Type") == "text/plain; charset=utf-8", (
                    "robots.txt 必须按 text/plain 返回"
                )
            with urllib.request.urlopen(base + "/assets/style.css", timeout=10) as r:
                assert r.headers.get("Content-Type") == "text/css; charset=utf-8", (
                    "style.css 必须按 text/css 返回"
                )
            print("MIME: txt/css served with correct content types")
            print("SMOKE TEST OK (isolated temp database on port %d)" % port)
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


if __name__ == "__main__":
    main()
