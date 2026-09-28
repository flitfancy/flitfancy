"""Small-file batching at the real service seam, with bounded concurrent storage."""
import hashlib
import io
from pathlib import Path
import tempfile
import threading

from bridge_test import LocalStorage, rejected, wait
from flitfancy_bridge import BridgeService, BATCH_WORKERS


def run():
    with tempfile.TemporaryDirectory(prefix='bridge-batch-test-') as temp:
        root = Path(temp)
        config = {'nas_bridge': {'host': '192.168.10.20', 'share': 'test', 'user': 'test', 'password': 'test-password', 'root': 'inbox'}}
        storage = LocalStorage(root / 'nas')
        service = BridgeService(lambda: config, config.update, root / 'state', lambda _: storage)
        bodies = [b'a', b'b' * 1024, b'', b'd' * 600]
        def manifest(folder='album'):
            return {'folder_root': folder, 'files': [
                {'path': folder + '/deep/%d.bin' % i, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()}
                for i, body in enumerate(bodies)]}
        def receive(data):
            task = service.begin_batch(data)
            blob = b''.join(bodies)
            service.chunk(task['id'], 0, 2, io.BytesIO(blob[:2]))
            assert service.status(task['id'])['received_bytes'] == 2
            service.chunk(task['id'], 2, len(blob) - 2, io.BytesIO(blob[2:]))
            return task
        try:
            task = receive(manifest())
            assert task['kind'] == 'batch' and task['file_count'] == 4
            assert [f['offset'] for f in task['files']] == [0, 1, 1025, 1025]
            rejected(lambda: service.begin_batch(manifest()), 409)
            service.commit(task['id'])
            result = wait(service, task)
            assert result['state'] == 'succeeded', result
            assert result['completed_files'] == 4 and result['sent_bytes'] == sum(map(len, bodies))
            for i, body in enumerate(bodies):
                assert storage.target('album/deep/%d.bin' % i).read_bytes() == body
            assert not list(storage.root.glob('.bridge-part-*'))
            assert not list((root / 'state').glob('*.part'))
            # A retry/reselection reuses identical content and never overwrites.
            before = storage.target('album/deep/0.bin').stat().st_mtime_ns
            task = receive(manifest())
            service.commit(task['id'])
            result = wait(service, task)
            assert result['state'] == 'succeeded' and all(f.get('reused') for f in result['files'])
            assert storage.target('album/deep/0.bin').stat().st_mtime_ns == before
            for mutation in [
                {'files': []}, {'folder_root': '../escape'},
                {'files': [{'path': 'album/%d' % i, 'size': 0, 'sha256': '0' * 64} for i in range(33)]},
                {'files': [{'path': 'album/%d' % i, 'size': 262144, 'sha256': '0' * 64} for i in range(17)]},
                {'files': [{'path': 'outside/a', 'size': 1, 'sha256': '0' * 64}]},
                {'files': [{'path': 'album/a', 'size': 262145, 'sha256': '0' * 64}]},
                {'files': [{'path': 'album/a', 'size': True, 'sha256': '0' * 64}]},
                {'files': [{'path': 'album/a', 'size': 1, 'sha256': 'bad'}]},
                {'files': [{'path': p, 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()} for p in ('album/a', 'album/A')]},
                {'files': [{'path': p, 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()} for p in ('album/a', 'album/a/b')]},
            ]:
                rejected(lambda mutation=mutation: service.begin_batch({**manifest(), **mutation}))

            # One corrupt NAS readback cannot publish that file; other verified
            # files remain successful, and retry sends only the unfinished item.
            class CorruptStorage(LocalStorage):
                def open(self, name, mode):
                    if mode == 'rb' and name.startswith('.bridge-part-') and name.endswith('-1'):
                        return io.BytesIO(b'corrupt')
                    return super().open(name, mode)
            service.storage_factory = lambda _: CorruptStorage(storage.root)
            task = receive(manifest('retry'))
            service.commit(task['id'])
            failed = wait(service, task)
            assert failed['state'] == 'failed' and failed['retryable']
            assert failed['completed_files'] == 3
            assert not storage.target('retry/deep/1.bin').exists()
            assert not list(storage.root.glob('.bridge-part-*'))
            assert service._part(task['id']).exists()
            timestamp = storage.target('retry/deep/0.bin').stat().st_mtime_ns
            service.storage_factory = lambda _: storage
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'succeeded'
            assert storage.target('retry/deep/0.bin').stat().st_mtime_ns == timestamp
            assert storage.target('retry/deep/1.bin').read_bytes() == bodies[1]

            # Verify the complete received manifest before any NAS file is written.
            bad = manifest('bad-digest')
            bad['files'][1]['sha256'] = '0' * 64
            task = receive(bad)
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'failed'
            assert not storage.target('bad-digest').exists()
            service.cancel(task['id'])

            # A conflicting destination remains intact while unrelated files finish.
            storage.target('album/deep/1.bin').write_bytes(b'unchanged conflict')
            task = receive(manifest())
            service.commit(task['id'])
            failed = wait(service, task)
            assert failed['state'] == 'failed' and failed['completed_files'] == 3
            assert storage.target('album/deep/1.bin').read_bytes() == b'unchanged conflict'
            service.cancel(task['id'])

            # Deterministic concurrency test: the first four workers meet at a
            # barrier. Serial execution cannot pass, and active workers are bounded.
            lock, barrier = threading.Lock(), threading.Barrier(BATCH_WORKERS)
            active = [0, 0]
            class ConcurrentStorage(LocalStorage):
                def stat(self, name):
                    if name.startswith('parallel/deep/') and name.endswith('.bin'):
                        with lock:
                            active[0] += 1
                            active[1] = max(active[1], active[0])
                        try:
                            barrier.wait(3)
                            return super().stat(name)
                        finally:
                            with lock:
                                active[0] -= 1
                    return super().stat(name)
            service.storage_factory = lambda _: ConcurrentStorage(storage.root)
            task = receive(manifest('parallel'))
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'succeeded'
            assert active[1] == BATCH_WORKERS
            service.storage_factory = lambda _: storage

            # Each concurrent worker owns a distinct connection cache. Reuse
            # those sessions across batches, and close all of them on shutdown.
            instances, ownership = [], {}
            ownership_barrier = threading.Barrier(BATCH_WORKERS)
            class OwnedStorage(LocalStorage):
                def __init__(self, path):
                    super().__init__(path)
                    self.closes = 0
                    instances.append(self)
                def open(self, name, mode):
                    if mode == 'xb':
                        ownership.setdefault(threading.get_ident(), set()).add(id(self))
                        ownership_barrier.wait(3)
                    return super().open(name, mode)
                def close(self):
                    self.closes += 1
            service.storage_factory = lambda _: OwnedStorage(storage.root)
            task = receive(manifest('owned'))
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'succeeded'
            assert len(instances) == BATCH_WORKERS
            assert len({id(value) for value in instances}) == BATCH_WORKERS
            assert all(len(used) == 1 for used in ownership.values())
            assert not any(value.closes for value in instances)
            ownership.clear()
            task = receive(manifest('owned-again'))
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'succeeded'
            assert len(instances) == BATCH_WORKERS, 'healthy worker sessions must be reused'
            service.configure(config['nas_bridge'])
            assert all(value.closes == 1 for value in instances), 'all worker sessions must be closed on reconfiguration'
            service.storage_factory = lambda _: storage

            # Empty files need no HTTP body; cancel removes only the local stage.
            empty = {'folder_root': 'empty', 'files': [{'path': 'empty/a', 'size': 0, 'sha256': hashlib.sha256(b'').hexdigest()}]}
            task = service.begin_batch(empty)
            service.commit(task['id'])
            assert wait(service, task)['state'] == 'succeeded' and storage.target('empty/a').stat().st_size == 0
            task = service.begin_batch(manifest('cancel'))
            service.cancel(task['id'])
            assert not service._part(task['id']).exists()
            assert not storage.target('cancel').exists()
        finally:
            service.close()
    print('bridge batches: bounds, concurrent writes, partial failure/retry, integrity, conflict, empty files and cancel passed')


if __name__ == '__main__':
    run()
