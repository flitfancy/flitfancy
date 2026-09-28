"""Authenticated usage summaries/exports over real HTTP, using synthetic AW data."""
import json
from dataclasses import fields
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import urllib.error
import urllib.request

from flitfancy_activity import ActivityService
from flitfancy_http import HttpDependencies, create_handler


def run():
    tz = timezone(timedelta(hours=8))
    begin = datetime(2026, 9, 26, 9, tzinfo=tz)
    now = (begin + timedelta(seconds=1810)).timestamp()
    class Source:
        offline = False
        def get_info(self):
            if self.offline:
                raise OSError('private-upstream-detail-must-not-leak')
            return {'hostname': 'fixture'}
        def get_buckets(self):
            self.get_info()
            return {key: {'id': key, 'type': kind, 'hostname': 'fixture', 'created': begin.isoformat()}
                    for key, kind in [('window', 'currentwindow'), ('afk', 'afkstatus')]}
        def get_events(self, bucket_id, limit=-1, start=None, end=None):
            self.get_info()
            windows = [{'id': 1, 'timestamp': begin.isoformat(), 'duration': 1800,
                        'data': {'app': 'Editor.exe', 'title': 'private-window-title', 'url': 'https://private.invalid'}}]
            afk = [{'id': 2, 'timestamp': begin.isoformat(), 'duration': 900, 'data': {'status': 'not-afk'}},
                   {'id': 3, 'timestamp': (begin + timedelta(seconds=900)).isoformat(), 'duration': 900, 'data': {'status': 'afk'}}]
            values = windows if bucket_id == 'window' else afk
            filtered = []
            for item in values:
                left = datetime.fromisoformat(item['timestamp'])
                right = left + timedelta(seconds=item['duration'])
                if (start is None or right > start) and (end is None or left < end):
                    filtered.append(item)
            filtered.sort(key=lambda item: item['timestamp'], reverse=True)
            return filtered[:limit] if limit is not None and limit >= 0 else filtered

    with tempfile.TemporaryDirectory(prefix='activity-http-test-') as temp:
        source = Source()
        service = ActivityService(Path(temp) / 'site.db', client=source, clock=lambda: now)
        service.sync_once(backfill_limit=0)
        deps = {field.name: lambda *a, **kw: None for field in fields(HttpDependencies)}
        deps.update(activity_service=service, now_iso=lambda: 'fixture',
                    admin_token_valid=lambda token, ip: token == 'test-password-activity')
        handler = create_handler(HttpDependencies(**deps))
        handler.log_message = lambda *args: None
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        def request(path, token=True, host=None):
            headers = {'Authorization': 'Bearer test-password-activity'} if token else {}
            if host:
                headers['Host'] = host
            req = urllib.request.Request('http://127.0.0.1:%d%s' % (server.server_port, path), headers=headers)
            try:
                response = urllib.request.urlopen(req, timeout=3)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                body = response.read().decode('utf-8')
                assert 'private-window-title' not in body and 'private.invalid' not in body
                assert 'private-upstream-detail' not in body
                return response.status, json.loads(body), response.headers
        try:
            for endpoint in ('summary', 'export'):
                path = '/api/activity/' + endpoint
                assert request(path, token=False)[0] == 401
                assert request(path, token=False, host='console.flitfancy.com')[0] == 401
                code, value, headers = request(path)
                assert code == 200 and headers['Cache-Control'] == 'no-store'
                assert value['range']['active_seconds'] == 900
            code, value, _ = request('/api/activity/summary?days=7&end=2026-09-26')
            assert code == 200 and value['today']['active_seconds'] == 900
            assert len(value['daily']) == 7
            for query in ('days=0', 'days=367', 'days=bad', 'end=not-a-date', 'end=2027-01-01'):
                assert request('/api/activity/summary?' + query)[0] == 400
            assert request('/api/activity/unknown')[0] == 404
            source.offline = True
            service.sync_once(backfill_limit=0)
            code, value, _ = request('/api/activity/summary')
            assert code == 200 and value['today']['active_seconds'] == 900
            assert value['source']['available'] is False
        finally:
            server.shutdown()
            server.server_close()
            thread.join(3)
            service.close()
    print('activity HTTP: private auth, summary/export, parameter bounds, offline archive and redacted fields passed')


if __name__ == '__main__':
    run()
