"""Exercise real HTTP dispatch with isolated domain dependencies; no live data."""
import io
import json
import threading
import urllib.error
import urllib.request
from dataclasses import fields
from datetime import timedelta, timezone
from email.message import Message
from http.server import ThreadingHTTPServer

from flitfancy_http import HttpDependencies, create_handler


class DomainReached(BaseException):
    pass


def reached(*args, **kwargs):
    raise DomainReached()


class Domain:
    def __getattr__(self, name):
        return reached


def run():
    validations = []
    def valid(token, ip):
        validations.append((token, ip))
        return token == 'fixture-valid' and ip == '127.0.0.1'
    deps = {f.name: reached for f in fields(HttpDependencies)}
    for key in ('audio_service', 'sensor_device_service', 'activity_service', 'bridge_service', 'launcher_service', 'observation_service',
                'resource_service', 'worker_client', 'ai_opener'):
        deps[key] = Domain()
    deps.update(admin_token_valid=valid, now_iso=lambda: '2026-09-20T00:00:00+08:00',
                read_local_config=lambda: {}, cfg_bool=lambda v, default: default if v is None else bool(v),
                normalize_reflections=lambda items: items, cst=timezone(timedelta(hours=8)),
                site_root='', mime={}, memories_select='*', sensor_retention_days=14)
    class Handler(create_handler(HttpDependencies(**deps))):
        def _send(self, code, *args, **kwargs):
            self.result = code
    class Connection:
        def settimeout(self, value):
            pass

    def request(method, path, token=None, remote=False, body=None, headers=None, peer='127.0.0.1'):
        validations.clear()
        handler = object.__new__(Handler)
        handler.path, handler.command = path, method
        handler.connection, handler.client_address = Connection(), (peer, 1)
        handler.headers = Message()
        raw = json.dumps(body or {}).encode()
        base_headers = {'Host': 'console.flitfancy.com' if remote else '127.0.0.1:2671',
                        'Content-Length': str(len(raw)), 'Content-Type': 'application/json'}
        if token is not None:
            base_headers['Authorization'] = 'Bearer ' + token
        base_headers.update(headers or {})
        for key, value in base_headers.items():
            handler.headers[key] = value
        handler.rfile = io.BytesIO(raw)
        try:
            getattr(handler, 'do_' + method)()
            return handler.result
        except DomainReached:
            return 299

    private_get = [
        '/api/refresh/status',
        '/api/sensors/device',
        '/api/sensors/heart-rate', '/api/sensors/heart-rate/history',
        '/api/activity/summary', '/api/activity/export',
        '/api/notes', '/api/audio/status', '/api/audio/history', '/api/audio/recording?name=test.wav',
        '/api/admin/session', '/api/admin/config', '/api/admin/essays', '/api/admin/observations', '/api/admin/observation-links',
        '/api/visits', '/api/launcher', '/api/bridge/config', '/api/bridge/status', '/api/bridge/transfers?id=test',
    ]
    private_post = [
        '/api/command', '/api/notes', '/api/memories', '/api/memories/import-static', '/api/anchors',
        '/api/essays', '/api/essays/featured', '/api/observations', '/api/observation-links', '/api/reflections',
        '/api/chat', '/api/dialogue/messages', '/api/audio/control', '/api/audio/play-file?filename=test.wav',
        '/api/audio/firmware', '/api/sensors/firmware', '/api/admin/config', '/api/admin/logout', '/api/resources/prepare',
        '/api/resources/upload?token=test', '/api/resources/update', '/api/resources/delete', '/api/resources/publish',
        '/api/launcher/save', '/api/launcher/delete', '/api/launcher/run', '/api/launcher/pick', '/api/launcher/resolve',
        '/api/bridge/config', '/api/bridge/test', '/api/bridge/directories', '/api/bridge/transfers', '/api/bridge/batches',
        '/api/bridge/transfers/commit', '/api/bridge/transfers/cancel', '/api/bridge/transfers/chunk?id=test&offset=0',
    ]
    for method, paths in [('GET', private_get), ('POST', private_post)]:
        for path in paths:
            for remote in (False, True):
                for token in (None, 'fixture-invalid', 'fixture-expired'):
                    assert request(method, path, token, remote) == 401, (method, path, remote, token)
                assert request(method, path, 'fixture-valid', remote) != 401, (method, path)
                assert len(validations) == 1, ('authentication must run once per request', method, path, validations)

    local_public = ['/api/status', '/api/resources', '/api/sensors/latest', '/api/sensors/history',
                    '/api/memories', '/api/anchors', '/api/essays', '/api/essays/featured',
                    '/api/observations', '/api/reflections']
    for path in local_public:
        assert request('GET', path) in (200, 299), path
        assert not validations, ('public local reads need no admin session', path)
        assert request('GET', path, remote=True) == 401, ('do not widen remote access', path)
    assert request('POST', '/api/ingest') == 299, 'local device ingestion must remain available'
    assert request('POST', '/api/ingest', remote=True) == 401
    for remote in (False, True):
        assert request('POST', '/api/admin/login', remote=remote, body={'username': 'fixture', 'password': 'fixture'}) == 299
        assert not validations
    for method, path in [('GET', '/api/future-admin'), ('POST', '/api/future-admin'),
                         ('GET', '/api/ingest'), ('POST', '/api/status'),
                         ('GET', '/api/admin/login'), ('POST', '/api/admin/login/')]:
        assert request(method, path) == 401, ('new routes and wrong methods must default to admin', method, path)
    assert request('GET', '/api/status', headers={'Host': 'localhost.evil.com'}) == 401
    assert request('GET', '/api/status', peer='192.168.1.9') == 401
    for token in (None, 'fixture-valid'):
        assert request('POST', '/api/notes', token, headers={'Sec-Fetch-Site': 'cross-site'}) == 403
        assert request('POST', '/api/ingest', token, headers={'Origin': 'https://untrusted.invalid'}) == 403

    # Real HTTP streaming: <audio src> cannot attach Bearer headers, whereas the
    # new authenticated fetch-to-Blob flow can retrieve the private recording.
    audio_bytes = b'RIFF-audio-fixture'
    class Recording(io.BytesIO):
        def getheader(self, name):
            return str(len(audio_bytes))
    class Audio:
        def open_recording(self, name):
            assert name == 'test.wav'
            return io.BytesIO(), Recording(audio_bytes)
    deps['audio_service'] = Audio()
    live_handler = create_handler(HttpDependencies(**deps))
    live_handler.log_message = lambda *args: None
    server = ThreadingHTTPServer(('127.0.0.1', 0), live_handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = 'http://127.0.0.1:%d/api/audio/recording?name=test.wav' % server.server_port
        for token, expected in [(None, 401), ('fixture-invalid', 401), ('fixture-valid', 200)]:
            headers = {'Authorization': 'Bearer ' + token} if token else {}
            try:
                response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=3)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                assert response.status == expected
                body = response.read()
                if expected == 200:
                    assert body == audio_bytes and response.headers['Content-Type'] == 'audio/wav'
    finally:
        server.shutdown()
        server.server_close()
        thread.join(3)
    print('auth policy: default-deny, local/remote private APIs, one check per request, explicit public/device exceptions and CSRF passed')


if __name__ == '__main__':
    run()
