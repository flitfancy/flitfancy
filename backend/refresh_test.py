"""Deterministic, payload-free refresh ledger and concurrent completion tests."""
from concurrent.futures import ThreadPoolExecutor
import json

from flitfancy_refresh import RefreshRegistry


def run():
    wall = [1000.0]
    monotonic = [20.0]
    registry = RefreshRegistry(clock=lambda: wall[0], monotonic=lambda: monotonic[0])
    def row(identifier):
        return next(item for item in registry.snapshot()['rows'] if item['id'] == identifier)

    snapshot = registry.snapshot()
    assert snapshot['schema'] == 1 and snapshot['startedAt'] == 1000000
    assert len(snapshot['rows']) == 9
    assert all(item['state'] == 'idle' and item['active'] == 0 and item['runs'] == 0 for item in snapshot['rows'])
    assert all(item['lastSuccessAt'] is None and item['lastStatus'] is None for item in snapshot['rows'])
    for excluded in ('/api/refresh/status', '/api/activity/export', '/api/audio/recording',
                     '/api/bridge/transfers', '/api/bridge/config', '/api/status/',
                     '/api/status?private-query=SECRET', 'SECRET'):
        assert registry.begin(excluded) is None, excluded

    first = registry.begin('/api/audio/status')
    second = registry.begin('/api/audio/status')
    assert row('audio-state')['state'] == 'running' and row('audio-state')['active'] == 2
    monotonic[0] += .125
    wall[0] += 1
    registry.finish(second, 503)
    current = row('audio-state')
    assert current['state'] == 'running' and current['active'] == 1
    assert current['runs'] == 1 and current['failures'] == 1 and current['lastStatus'] == 503
    assert current['durationMs'] == 125 and current['lastSuccessAt'] is None
    # Wall-clock adjustments must not distort elapsed time or leave active work stuck.
    wall[0] -= 10
    monotonic[0] += .125
    registry.finish(first, 200)
    current = row('audio-state')
    assert current['state'] == 'success' and current['active'] == 0
    assert current['runs'] == 2 and current['failures'] == 0 and current['durationMs'] == 250
    assert current['lastSuccessAt'] == 991000
    registry.finish(first, 500)
    assert row('audio-state') == current, 'completion must be idempotent'
    # Snapshots must not expose mutable registry state.
    current['runs'] = 999
    assert row('audio-state')['runs'] == 2

    ticket = registry.begin('/api/activity/summary')
    registry.finish(ticket, None)
    assert row('activity')['state'] == 'error' and row('activity')['lastStatus'] == 500
    ticket = registry.begin('/api/activity/summary')
    registry.finish(ticket, 200, failed=True)
    assert row('activity')['lastStatus'] == 500 and row('activity')['failures'] == 2
    assert 'SECRET' not in json.dumps(registry.snapshot())

    concurrent = RefreshRegistry()
    def complete(_):
        token = concurrent.begin('/api/sensors/latest')
        concurrent.snapshot()
        concurrent.finish(token, 200)
        concurrent.finish(token, 500)
    with ThreadPoolExecutor(max_workers=12) as executor:
        list(executor.map(complete, range(300)))
    current = next(item for item in concurrent.snapshot()['rows'] if item['id'] == 'sensors-latest')
    assert current['runs'] == 300 and current['active'] == 0 and current['failures'] == 0
    assert current['state'] == 'success'
    print('refresh ledger: fixed catalog, timing, failures, idempotent completion and concurrency passed')


if __name__ == '__main__':
    run()
