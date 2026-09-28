"""Bridge API contract and transfer integrity, using temporary local storage only."""
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import fields
from http.server import ThreadingHTTPServer

from flitfancy_bridge import BridgeService, BridgeError, SMBStorage, relative_path, CHUNK_BYTES
from flitfancy_http import HttpDependencies, create_handler


class LocalStorage:
    def __init__(self, root):
        self.root = Path(root)

    def target(self, name):
        return self.root.joinpath(*name.split('/'))

    def ensure_root(self):
        self.root.mkdir(exist_ok=True)

    def stat(self, name):
        return self.target(name).stat()

    def open(self, name, mode):
        return self.target(name).open(mode)

    def mkdir(self, name):
        self.target(name).mkdir()

    def rename(self, src, dst):
        os.link(self.target(src), self.target(dst))
        self.target(src).unlink()

    def remove(self, name):
        self.target(name).unlink()

    def close(self):
        pass


def rejected(work, status=400):
    try:
        work()
    except BridgeError as error:
        assert error.status == status, (str(error), error.status, status)
    else:
        raise AssertionError('Expected rejection')


def wait(service, task):
    service.thread.join(10)
    assert not service.thread.is_alive()
    return service.status(task['id'])


def run():
    for value in ('../x', '/x', 'a/../b', 'a//b', 'a\\b', 'x:y', 'con.txt', 'a.', 'a ', 'x\x00y', '.bridge-part-x', '\ud800'):
        rejected(lambda value=value: relative_path(value))
    assert relative_path('资料/测试.txt') == '资料/测试.txt'
    adapter = object.__new__(SMBStorage)
    adapter.base, adapter.root, adapter.options = '\\\\example\\share', 'private', {}
    class FakeSMB:
        def stat(self, path, **kwargs):
            assert kwargs['follow_symlinks'] is False
            return type('Info', (), {'st_mode': stat.S_IFDIR, 'st_file_attributes': 0x400 if 'jump' in path else 0})()
    adapter.client = FakeSMB()
    rejected(lambda: adapter._path('jump/file'), 403)

    # Existing deep directories need one fully validated lookup, not every
    # prefix queried again (which makes per-file metadata checks quadratic).
    class ExistingDirectories:
        def __init__(self):
            self.reads = []
        def stat(self, path):
            self.reads.append(path)
            return type('Info', (), {'st_mode': stat.S_IFDIR})()
    existing = ExistingDirectories()
    BridgeService._make_directories(existing, 'one/two/three/four/five', set())
    assert existing.reads == ['one/two/three/four/five'], existing.reads

    with tempfile.TemporaryDirectory(prefix='flitfancy-bridge-test-') as temp:
        root = Path(temp)
        # A folder of tiny files must share one healthy NAS connection.
        connections, closes = [], []
        class CountedStorage(LocalStorage):
            def __init__(self, target):
                super().__init__(target)
                connections.append(self)
            def close(self):
                closes.append(self)
        perf_config = {'nas_bridge': {'host': '192.168.10.20', 'share': 'test', 'user': 'test', 'password': 'fixture-only', 'root': 'inbox'}}
        perf = BridgeService(lambda: perf_config, perf_config.update, root / 'perf-state', lambda _: CountedStorage(root / 'perf-nas'))
        try:
            for i in range(5):
                tiny = perf.begin({'path': str(i), 'size': 1, 'sha256': hashlib.sha256(b'x').hexdigest()})
                perf.chunk(tiny['id'], 0, 1, io.BytesIO(b'x'))
                assert wait(perf, perf.commit(tiny['id']))['state'] == 'succeeded'
            assert len(connections) == 1, ('tiny files reconnect to NAS', len(connections))
            assert not closes
            perf.storage_used = time.monotonic() - 61
            assert wait(perf, perf.test_connection())['state'] == 'succeeded'
            assert len(connections) == 2 and len(closes) == 1, 'idle connection must be renewed'
            perf.configure(perf_config['nas_bridge'])
            assert len(closes) == 2, 'saving configuration releases the previous session'
        finally:
            perf.close()
        assert len(closes) == 2
        storage = LocalStorage(root / 'nas')
        config = {'nas_bridge': {'host': '192.168.10.20', 'share': 'test', 'user': 'test', 'password': 'fixture-only', 'root': 'inbox'}}
        tick = [1000]
        factory = lambda _: storage
        service = BridgeService(lambda: config, config.update, root / 'state', factory, lambda: tick[0])
        assert 'fixture-only' not in json.dumps(service.config())
        for host in ('127.0.0.1', '8.8.8.8', 'localhost', 'http://192.168.1.1'):
            rejected(lambda host=host: service.configure({**config['nas_bridge'], 'host': host}))
        service.configure({**config['nas_bridge'], 'password': ''})
        assert config['nas_bridge']['password'] == 'fixture-only'
        assert wait(service, service.test_connection())['state'] == 'succeeded'
        assert list(storage.root.iterdir()) == []

        def begin(path, body, sha=None):
            return service.begin({'path': path, 'size': len(body), 'sha256': sha or hashlib.sha256(body).hexdigest()})

        body = '桥接测试 🌉'.encode()
        task = begin('资料/测试.txt', body)
        rejected(lambda: begin('other', b''), 409)
        rejected(lambda: service.configure(config['nas_bridge']), 409)
        rejected(lambda: service.commit(task['id']), 409)
        rejected(lambda: service.chunk(task['id'], 1, 3, io.BytesIO(body)), 409)
        rejected(lambda: service.chunk(task['id'], 0, len(body), io.BytesIO(b'short')))
        assert service.status(task['id'])['received_bytes'] == 0
        service.chunk(task['id'], 0, 4, io.BytesIO(body[:4]))
        rejected(lambda: service.chunk(task['id'], 0, 4, io.BytesIO(body)), 409)
        service.chunk(task['id'], 4, len(body)-4, io.BytesIO(body[4:]))
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'succeeded'
        assert storage.target('资料/测试.txt').read_bytes() == body
        assert service.commit(task['id'])['state'] == 'succeeded'
        assert not list((root / 'state').glob('*.part'))
        task = begin('资料/测试.txt', b'')
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'failed'
        assert storage.target('资料/测试.txt').read_bytes() == body
        service.cancel(task['id'])
        task = begin('bad.txt', body, '0'*64)
        service.chunk(task['id'], 0, len(body), io.BytesIO(body))
        service.commit(task['id'])
        assert 'SHA-256' in wait(service, task)['error']
        assert not storage.target('bad.txt').exists()
        service.cancel(task['id'])
        task = begin('empty.txt', b'')
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'succeeded'
        assert storage.target('empty.txt').stat().st_size == 0

        rejected(lambda: service.begin({'path': 'outside/file', 'folder_root': 'inside', 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()}))
        # Folder structure includes empty directories and repeats safely.
        for _ in range(2):
            directories = service.directories({'paths': ['album', 'album/sub/empty', 'album/sub']})
            result = wait(service, directories)
            assert result['state'] == 'succeeded'
            assert storage.target('album/sub/empty').is_dir()
        rejected(lambda: service.directories({'paths': ['../outside']}))
        rejected(lambda: service.directories({'paths': []}))
        rejected(lambda: service.directories({'paths': ['fine', 42]}))
        task = service.directories({'paths': ['empty.txt/sub']})
        assert wait(service, task)['state'] == 'failed'
        assert storage.target('empty.txt').stat().st_size == 0
        # Folder retries may reuse an identical file, never overwrite a different one.
        original_time = storage.target('资料/测试.txt').stat().st_mtime_ns
        task = service.begin({'path': '资料/测试.txt', 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest(), 'reuse_identical': True})
        service.chunk(task['id'], 0, len(body), io.BytesIO(body))
        service.commit(task['id'])
        result = wait(service, task)
        assert result['state'] == 'succeeded' and result['reused']
        assert storage.target('资料/测试.txt').stat().st_mtime_ns == original_time
        changed = b'!' * len(body)
        task = service.begin({'path': '资料/测试.txt', 'size': len(changed), 'sha256': hashlib.sha256(changed).hexdigest(), 'reuse_identical': True})
        service.chunk(task['id'], 0, len(changed), io.BytesIO(changed))
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'failed'
        assert storage.target('资料/测试.txt').read_bytes() == body
        service.cancel(task['id'])

        # A disconnect keeps the staged data; retrying commit does not need a second upload.
        class FailingStorage(LocalStorage):
            def rename(self, src, dst):
                raise OSError('private-server-secret-must-not-leak')
        service.storage_factory = lambda _: FailingStorage(storage.root)
        task = begin('retry.txt', body)
        service.chunk(task['id'], 0, len(body), io.BytesIO(body))
        service.commit(task['id'])
        result = wait(service, task)
        assert result['state'] == 'failed' and result['retryable']
        assert 'private-server-secret' not in json.dumps(result)
        assert not storage.target('retry.txt').exists()
        service.storage_factory = factory
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'succeeded'
        # Readback corruption must never publish the destination.
        class CorruptStorage(LocalStorage):
            def open(self, name, mode):
                if mode == 'rb' and name.startswith('.bridge-part-'):
                    return io.BytesIO(b'corrupt')
                return super().open(name, mode)
        service.storage_factory = lambda _: CorruptStorage(storage.root)
        task = begin('corrupt.bin', body)
        service.chunk(task['id'], 0, len(body), io.BytesIO(body))
        service.commit(task['id'])
        assert wait(service, task)['state'] == 'failed'
        assert not storage.target('corrupt.bin').exists()
        service.cancel(task['id'])
        service.storage_factory = factory
        task = begin('expired', b'')
        tick[0] += 3601
        assert service.status(task['id'])['state'] == 'expired'
        assert not service._part(task['id']).exists()

        # Process locking and restart recovery never pretend an unfinished upload succeeded.
        task = begin('interrupted', body)
        other = BridgeService(lambda: config, config.update, root / 'state', factory)
        rejected(lambda: other.status(), 409)
        service.close()
        service = BridgeService(lambda: config, config.update, root / 'state', factory, lambda: tick[0])
        assert service.status(task['id'])['state'] == 'failed'
        assert service.status(task['id'])['retryable'] is False
        assert not service._part(task['id']).exists()

        deps = {field.name: lambda *a, **kw: None for field in fields(HttpDependencies)}
        deps.update(bridge_service=service, now_iso=lambda: 'test', admin_token_valid=lambda token, ip: token == 'test-password-bridge')
        handler = create_handler(HttpDependencies(**deps))
        handler.log_message = lambda self, *args: None
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = 'http://127.0.0.1:%d' % server.server_port
        def request(path, data=None, token=True, headers=None, raw=None):
            request_headers = {'Authorization': 'Bearer test-password-bridge'} if token else {}
            request_headers.update(headers or {})
            req = urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else raw, headers=request_headers)
            try:
                response = urllib.request.urlopen(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                return response.status, response.headers, json.loads(response.read())
        try:
            for endpoint in ('config', 'status', 'transfers?id=unknown'):
                assert request('/api/bridge/'+endpoint, token=False)[0] == 401
            assert request('/api/bridge/test', token=False, raw=b'')[0] == 401
            assert request('/api/bridge/test', raw=b'', headers={'Sec-Fetch-Site': 'cross-site'})[0] == 403
            assert request('/api/bridge/test', raw=b'', headers={'Origin': 'https://untrusted.example'})[0] == 403
            code, headers, data = request('/api/bridge/config')
            assert code == 200 and headers['Cache-Control'] == 'no-store'
            assert 'fixture-only' not in json.dumps(data)
            assert request('/api/bridge/backup', {})[0] == 404
            assert request('/api/bridge/directories', token=False, raw=b'')[0] == 401
            assert request('/api/bridge/directories', {'paths': ['../bad']})[0] == 400
            code, _, directory_task = request('/api/bridge/directories', {'paths': ['http-folder/空目录']})
            assert code == 202 and wait(service, directory_task)['state'] == 'succeeded'
            assert storage.target('http-folder/空目录').is_dir()
            assert request('/api/bridge/transfers/commit', {'id': []})[0] == 400
            for invalid in (-1, True, '1'):
                assert request('/api/bridge/transfers', {'path': 'invalid', 'size': invalid, 'sha256': '0'*64})[0] == 400
            code, _, task = request('/api/bridge/transfers', {'path': 'http.bin', 'size': 6, 'sha256': hashlib.sha256(b'abcdef').hexdigest()})
            assert code == 200
            assert request('/api/bridge/transfers/chunk?id='+task['id']+'&offset=0', raw=b'abcdef')[0] == 200
            assert request('/api/bridge/transfers/commit', {'id': task['id']})[0] == 202
            assert wait(service, task)['state'] == 'succeeded'
            assert storage.target('http.bin').read_bytes() == b'abcdef'
            assert request('/api/bridge/transfers?id='+task['id'])[2]['sent_bytes'] == 6
            for value in ('-1', '5001', 'invalid'):
                assert request('/api/bridge/transfers?id='+task['id']+'&wait_ms='+value)[0] == 400
            assert request('/api/bridge/transfers?id='+task['id']+'&wait_ms=2000', token=False)[0] == 401
            # A real HTTP long poll wakes when the worker finishes, without
            # blocking ordinary status requests or waiting out the full timeout.
            entered, release, waiting = threading.Event(), threading.Event(), threading.Event()
            class GatedStorage(LocalStorage):
                def ensure_root(self):
                    entered.set()
                    assert release.wait(5)
                    super().ensure_root()
            service.storage_factory = lambda _: GatedStorage(storage.root)
            code, _, task = request('/api/bridge/test', {})
            assert code == 202 and entered.wait(2)
            original_wait = service.changed.wait
            def observed_wait(timeout=None):
                waiting.set()
                return original_wait(timeout)
            service.changed.wait = observed_wait
            responses = []
            def poll():
                responses.append(request('/api/bridge/transfers?id='+task['id']+'&wait_ms=2000'))
            reader = threading.Thread(target=poll)
            reader.start()
            try:
                assert waiting.wait(2)
                assert request('/api/bridge/transfers?id='+task['id'])[2]['state'] == 'testing'
                start = time.monotonic()
                release.set()
                reader.join(1)
                assert not reader.is_alive(), 'completion must wake HTTP response immediately'
                assert responses[0][2]['state'] == 'succeeded'
                assert time.monotonic() - start < 1
            finally:
                release.set()
                reader.join(5)
                service.changed.wait = original_wait
                service.storage_factory = factory
            code, _, task = request('/api/bridge/test', {})
            assert code == 202 and wait(service, task)['state'] == 'succeeded'
        finally:
            server.shutdown()
            server.server_close()
            service.close()
    print('bridge API: authentication, chunking, integrity, conflict, retry and restart checks passed')


if __name__ == '__main__':
    run()
