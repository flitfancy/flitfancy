"""Real isolated HTTP refresh observation, authentication and privacy regression."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import fields
from datetime import timezone
from http.client import RemoteDisconnected
from http.server import ThreadingHTTPServer
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import urllib.error
import urllib.request

from flitfancy_http import HttpDependencies, create_handler


SECRET = 'PRIVATE_REFRESH_FIXTURE_ONLY'
TOKEN = 'fixture-refresh-admin'


@contextmanager
def fixture():
    counts = Counter()
    control = {'audio': 'ok'}
    entered = threading.Event()
    release = threading.Event()
    def forbidden(*args, **kwargs):
        raise AssertionError('Unexpected fixture dependency')
    class Domain:
        def __getattr__(self, name):
            return forbidden
    class Audio:
        def status(self):
            counts['audio'] += 1
            if control['audio'] == 'crash':
                raise RuntimeError(SECRET)
            if control['audio'] == 'block':
                entered.set()
                assert release.wait(3)
            return {'online': False, 'private': SECRET}
        def history(self, *args):
            counts['audio-history'] += 1
            raise ValueError(SECRET)
        def open_recording(self, name):
            counts['recording'] += 1
            class Recording(io.BytesIO):
                def getheader(self, name):
                    return '4'
            return io.BytesIO(), Recording(b'RIFF')
    class Activity:
        def summary(self, **kwargs):
            counts['activity'] += 1
            return {'private': SECRET}
        def export(self, **kwargs):
            counts['export'] += 1
            return {'private': SECRET}
    class Bridge:
        def status(self, *args, **kwargs):
            counts['bridge'] += 1
            return {'filename': SECRET}
        def config(self):
            counts['bridge-config'] += 1
            return {'path': SECRET}
    class Launcher:
        def catalog(self):
            counts['launcher'] += 1
            raise OSError(SECRET)
    with tempfile.TemporaryDirectory(prefix='flitfancy-refresh-test-') as temp:
        database = Path(temp) / 'fixture.db'
        def db():
            counts['db'] += 1
            connection = sqlite3.connect(database)
            connection.row_factory = sqlite3.Row
            return connection
        with closing(sqlite3.connect(database)) as connection:
            with connection:
                connection.executescript('CREATE TABLE sensors(id INTEGER, board TEXT, channel TEXT);'
                                         'CREATE TABLE memories(id INTEGER, memory_time TEXT, content TEXT);')
                connection.execute('INSERT INTO memories VALUES (1, ?, ?)', ('2026-09-27', SECRET))
        deps = {item.name: forbidden for item in fields(HttpDependencies)}
        for key in ('observation_service', 'resource_service', 'worker_client', 'ai_opener'):
            deps[key] = Domain()
        deps.update(audio_service=Audio(), activity_service=Activity(), bridge_service=Bridge(),
                    launcher_service=Launcher(), admin_token_valid=lambda token, ip: token == TOKEN,
                    now_iso=lambda: '2026-09-27T00:00:00+08:00', read_local_config=lambda: {},
                    cfg_bool=lambda value, default: default, cst=timezone.utc, site_root=temp,
                    mime={}, memories_select='*', sensor_retention_days=14, db=db,
                    sensor_row_public=lambda row: row, status_counts=lambda: (0, 0),
                    protocol_name=lambda: 'fixture', service_status=lambda: {'listener': False, 'audio': False, 'tunnel': False})
        class Server(ThreadingHTTPServer):
            def handle_error(self, request, address):
                counts['unhandled'] += 1
        handler = create_handler(HttpDependencies(**deps))
        handler.log_message = lambda *args: None
        server = Server(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path, token=TOKEN, remote=True, method='GET'):
            headers = {'Host': 'console.flitfancy.com' if remote else '127.0.0.1'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            call = urllib.request.Request('http://127.0.0.1:%d%s' % (server.server_port, path), headers=headers, method=method)
            try:
                response = opener.open(call, timeout=4)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                raw = response.read()
                body = json.loads(raw) if response.headers.get_content_type() == 'application/json' else raw
                return response.status, body, response.headers
        try:
            yield request, counts, control, entered, release
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            thread.join(3)


def run():
    with fixture() as (request, counts, control, entered, release):
        def snapshot():
            code, data, headers = request('/api/refresh/status')
            assert code == 200
            assert headers['Cache-Control'] == 'no-store'
            return data
        def row(identifier):
            return next(item for item in snapshot()['rows'] if item['id'] == identifier)
        initial = snapshot()
        assert initial['schema'] == 1 and len(initial['rows']) == 9
        assert all(item['state'] == 'idle' for item in initial['rows'])
        for remote in (False, True):
            for token in (None, 'invalid'):
                assert request('/api/refresh/status', token=token, remote=remote)[0] == 401
                assert request('/api/audio/status', token=token, remote=remote)[0] == 401
        assert all(item['runs'] == 0 and item['active'] == 0 for item in snapshot()['rows'])
        before = counts.copy()
        for _ in range(4):
            snapshot()
        assert counts == before, 'status snapshots must not call business dependencies'
        for path, identifier, expected in [('/api/status', 'site-status', 200),
                                          ('/api/sensors/latest', 'sensors-latest', 200),
                                          ('/api/sensors/history', 'sensor-history', 200),
                                          ('/api/audio/status', 'audio-state', 200),
                                          ('/api/audio/history', 'audio-history', 502),
                                          ('/api/activity/summary', 'activity', 200),
                                          ('/api/bridge/status', 'bridge-status', 200),
                                          ('/api/launcher', 'launcher-status', 503),
                                          ('/api/memories', 'memories', 200)]:
            assert request(path + '?private=' + SECRET)[0] == expected
            observed = row(identifier)
            assert observed['lastStatus'] == expected and observed['runs'] == 1 and observed['active'] == 0
            assert observed['state'] == ('success' if expected == 200 else 'error')
        assert row('audio-state')['state'] == 'success', 'HTTP success is independent of upstream online flag'
        before_rows = snapshot()['rows']
        for path in ('/api/activity/export', '/api/audio/recording?name=' + SECRET,
                     '/api/bridge/config', '/api/bridge/transfers?id=' + SECRET, '/api/admin/session'):
            assert request(path)[0] == 200
        assert snapshot()['rows'] == before_rows, 'excluded reads must not affect observed tasks'
        local_status, local_body, _ = request('/api/status', token=None, remote=False)
        assert local_status == 200 and local_body['capabilities']['refresh_ledger'] == 1
        assert row('site-status')['runs'] == 2, 'allowed local anonymous reads are actual reads too'
        # A private bad query is an actual authorized failed refresh, not an auth rejection.
        assert request('/api/activity/summary?days=bad-' + SECRET)[0] == 400
        assert row('activity')['failures'] == 1 and row('activity')['lastStatus'] == 400
        control['audio'] = 'crash'
        try:
            request('/api/audio/status')
            raise AssertionError('Uncaught route exception must retain its existing HTTP behavior')
        except (RemoteDisconnected, urllib.error.URLError):
            pass
        assert row('audio-state')['state'] == 'error' and row('audio-state')['lastStatus'] == 500
        assert row('audio-state')['active'] == 0
        control['audio'] = 'block'
        with ThreadPoolExecutor(max_workers=2) as executor:
            future = executor.submit(request, '/api/audio/status')
            assert entered.wait(2)
            active = row('audio-state')
            assert active['state'] == 'running' and active['active'] == 1
            release.set()
            assert future.result()[0] == 200
        observed = row('audio-state')
        assert observed['runs'] == 3 and observed['failures'] == 0 and observed['active'] == 0
        control['audio'] = 'ok'
        with ThreadPoolExecutor(max_workers=8) as executor:
            assert all(result[0] == 200 for result in executor.map(lambda _: request('/api/audio/status'), range(32)))
        assert row('audio-state')['runs'] == 35 and row('audio-state')['active'] == 0
        encoded = json.dumps(snapshot())
        for secret in (SECRET, TOKEN, '/api/', 'console.flitfancy.com', '127.0.0.1'):
            assert secret not in encoded, secret
        allowed = {'id', 'state', 'lastStartedAt', 'lastFinishedAt', 'lastSuccessAt', 'durationMs', 'runs', 'failures', 'active', 'lastStatus'}
        assert all(set(item) == allowed for item in snapshot()['rows'])
    with fixture() as (request, _, _, _, _):
        assert all(item['runs'] == 0 for item in request('/api/refresh/status')[1]['rows']), 'fresh backend registry resets'
    print('refresh HTTP: private snapshots, exact reads, failures, concurrency, isolation and metadata privacy passed')


if __name__ == '__main__':
    run()
