"""In-memory observations of actual approved API reads; never a polling service."""
from threading import Lock
import time
from types import MappingProxyType


REFRESH_ROUTES = MappingProxyType({
    '/api/status': 'site-status',
    '/api/sensors/latest': 'sensors-latest',
    '/api/sensors/history': 'sensor-history',
    '/api/audio/status': 'audio-state',
    '/api/audio/history': 'audio-history',
    '/api/activity/summary': 'activity',
    '/api/bridge/status': 'bridge-status',
    '/api/launcher': 'launcher-status',
    '/api/memories': 'memories',
})


class RefreshRegistry:
    """One handler factory owns one registry, shared safely across HTTP threads.

    A successful read means the HTTP handler returned a 2xx response. It does
    not promise that an upstream device is online or that a browser received
    the response. Counts and last results are ordered by request completion.
    """
    def __init__(self, *, clock=time.time, monotonic=time.monotonic):
        self._clock = clock
        self._monotonic = monotonic
        self._lock = Lock()
        self._started_at = int(clock() * 1000)
        self._sequence = 0
        self._pending = {}
        self._rows = {
            identifier: {
                'id': identifier, 'state': 'idle', 'lastStartedAt': None,
                'lastFinishedAt': None, 'lastSuccessAt': None, 'durationMs': None,
                'runs': 0, 'failures': 0, 'active': 0, 'lastStatus': None,
            }
            for identifier in REFRESH_ROUTES.values()
        }

    def begin(self, path):
        """Accept only exact route names, with no query, payload or user data."""
        identifier = REFRESH_ROUTES.get(path)
        if identifier is None:
            return None
        with self._lock:
            self._sequence += 1
            ticket = self._sequence
            self._pending[ticket] = (identifier, self._monotonic())
            row = self._rows[identifier]
            row['lastStartedAt'] = int(self._clock() * 1000)
            row['active'] += 1
            row['state'] = 'running'
            return ticket

    def finish(self, ticket, status, *, failed=False):
        """Release exactly one active read, including a handler that raised."""
        with self._lock:
            pending = self._pending.pop(ticket, None)
            if pending is None:
                return
            identifier, started = pending
            code = status if isinstance(status, int) and 100 <= status <= 599 else 500
            if failed:
                code = 500
            success = 200 <= code < 300
            finished = int(self._clock() * 1000)
            row = self._rows[identifier]
            row['active'] -= 1
            row['runs'] += 1
            row['lastFinishedAt'] = finished
            row['lastStatus'] = code
            row['durationMs'] = max(0, round((self._monotonic() - started) * 1000))
            row['failures'] = 0 if success else row['failures'] + 1
            if success:
                row['lastSuccessAt'] = finished
            row['state'] = 'running' if row['active'] else ('success' if success else 'error')

    def snapshot(self):
        """Copy fixed, bounded metadata only; never execute a business read."""
        with self._lock:
            return {
                'schema': 1,
                'startedAt': self._started_at,
                'generatedAt': int(self._clock() * 1000),
                'rows': [dict(row) for row in self._rows.values()],
            }
