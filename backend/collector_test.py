"""Real HTTP mobile pairing/upload boundaries, durable dedup and delayed samples."""
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import urllib.error
import urllib.request


def run():
    with tempfile.TemporaryDirectory(prefix="flit-collector-test-") as temporary:
        root = Path(temporary)
        config = root / "config.json"
        config.write_text('{}')
        os.environ.update(FLITFANCY_DB_PATH=str(root / "data.db"), FLITFANCY_AI_CONFIG_PATH=str(config),
                          FLITFANCY_SENSOR_RAW_DATA_DIR=str(root / "raw"), FLITFANCY_ACTIVITYWATCH_ENABLED="0")
        import server
        from flitfancy_collectors import CollectorError
        from flitfancy_storage import latest_sensor_rows
        server.db_init()
        server._set_admin_password("fixture-admin", "fixture-password-for-test", create=True)
        listener = server.FlitFancyServer(("127.0.0.1", 0), server.Handler)
        thread = threading.Thread(target=listener.serve_forever, daemon=True)
        thread.start()

        def request(path, body=None, token=None):
            headers = {"Content-Type": "application/json", "Host": "console.flitfancy.com"}
            if token:
                headers["Authorization"] = "Bearer " + token
            packet = None if body is None else json.dumps(body).encode()
            try:
                response = urllib.request.urlopen(urllib.request.Request(
                    "http://127.0.0.1:%d%s" % (listener.server_port, path), data=packet, headers=headers), timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, json.loads(response.read())

        try:
            assert request('/api/collectors')[0] == 401
            assert request('/api/collectors/pairing', {"name": "手机"})[0] == 401
            status, login = request('/api/admin/login', {"username": "fixture-admin", "password": "fixture-password-for-test"})
            assert status == 200
            admin = login['token']
            status, pairing = request('/api/collectors/pairing', {"name": "测试手机"}, admin)
            assert status == 200
            status, device = request('/api/collectors/claim', {"pairing_code": pairing['pairing_code']})
            assert status == 200
            token = device['collector_token']
            assert request('/api/collectors/claim', {"pairing_code": pairing['pairing_code']})[0] == 401
            assert request('/api/admin/config', token=token)[0] == 401
            assert request('/api/collectors/ingest', {"protocol": 1, "events": []})[0] == 401
            now = datetime.now(timezone.utc)
            row = {"ts": now.isoformat(), "board": "fixture-board", "channel": "CH6", "channel_index": 6,
                   "sensor": "CH6 BLE-HR", "ok": 1, "heart_rate_bpm": 76, "hr_connected": 1,
                   "sample_age_ms": 250, "sample_seq": 3, "uptime_ms": 1000, "cycle": 1, "hr_state": "streaming"}
            event_id = hashlib.sha256(b'fixture-event').hexdigest()
            batch = {"protocol": 1, "events": [{"event_id": event_id, "row": row}]}
            status, saved = request('/api/collectors/ingest', batch, token)
            assert status == 200 and saved['accepted'] == 1 and saved['acknowledged'] == [event_id]
            status, retry = request('/api/collectors/ingest', batch, token)
            assert status == 200 and retry['duplicates'] == 1 and retry['accepted'] == 0
            assert request('/api/collectors/ingest', {"protocol": 1, "events": [{"event_id": event_id, "row": {**row, "heart_rate_bpm": 80}}]}, token)[0] == 409
            bad = {"protocol": 1, "events": [{"event_id": hashlib.sha256(b'bad').hexdigest(), "row": {**row, "address": "MUST_NOT_PUBLISH"}}]}
            assert request('/api/collectors/ingest', bad, token)[0] == 400
            # A desktop transport receiving the same physical board frame does
            # not create another measurement; receipt/source metadata survive.
            server.ingest_json(row)
            with contextlib.closing(server.db()) as con:
                assert con.execute('SELECT COUNT(*) FROM sensors').fetchone()[0] == 1
            old_id = hashlib.sha256(b'old-event').hexdigest()
            old = {**row, "ts": (now - timedelta(hours=2)).isoformat(), "heart_rate_bpm": 60}
            assert request('/api/collectors/ingest', {"protocol": 1, "events": [{"event_id": old_id, "row": old}]}, token)[0] == 200
            with contextlib.closing(server.db()) as con:
                live = dict(latest_sensor_rows(con, "CH6")[0])
                assert json.loads(live['extra'])['heart_rate_bpm'] == 76, "Backfill must not replace live data"
                assert con.execute('SELECT COUNT(*) FROM sensors').fetchone()[0] == 2
                credentials = con.execute('SELECT token_hash FROM collector_devices').fetchone()[0]
                assert credentials != token
            raw = list((root / 'raw/collectors').rglob('*.jsonl'))
            assert len(raw) == 1 and len(raw[0].read_text(encoding='utf-8').splitlines()) == 2
            assert token not in raw[0].read_text(encoding='utf-8')
            from flitfancy_collectors import CollectorService
            blocked_archive = root / 'blocked-archive'
            blocked_archive.write_text('fixture')
            failing = CollectorService(server.db, server.ingest_json, blocked_archive)
            failed_id = hashlib.sha256(b'archive-failure').hexdigest()
            try:
                failing.ingest_batch(failing.authenticate('Bearer '+token),
                    {"protocol":1,"events":[{"event_id":failed_id,"row":{**row,"heart_rate_bpm":82,"uptime_ms":2000}}]})
                raise AssertionError('Archive failure must reject acknowledgement')
            except OSError:
                pass
            with contextlib.closing(server.db()) as con:
                assert con.execute('SELECT COUNT(*) FROM sensors').fetchone()[0] == 2
                assert not con.execute('SELECT 1 FROM collector_receipts WHERE event_id=?',(failed_id,)).fetchone()
            assert request('/api/collectors/revoke', {"device_id": device['device_id']}, admin)[0] == 200
            assert request('/api/collectors/ingest', batch, token)[0] == 401
            assert request('/api/collectors')[0] == 401
            assert request('/api/collectors', token=admin)[1]['devices'][0]['revoked_at'] is not None
            print('Mobile collectors: HTTP auth, one-use pairing, scoped token, revoke, raw archive, retry dedup, conflicts, field filtering and old-upload live-data protection passed')
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join(timeout=3)


if __name__ == '__main__':
    run()
