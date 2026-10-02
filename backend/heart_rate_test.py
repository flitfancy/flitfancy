"""Production schema-5 parsing, storage, authenticated routes and public-sync boundary."""
import json
import os
from pathlib import Path
import tempfile
from unittest import mock


def run():
    with tempfile.TemporaryDirectory(prefix='flitfancy-heart-rate-') as temporary:
        config = Path(temporary) / 'config.json'
        config.write_text('{}', encoding='utf-8')
        os.environ['FLITFANCY_DB_PATH'] = str(Path(temporary) / 'data.db')
        os.environ['FLITFANCY_AI_CONFIG_PATH'] = str(config)
        import server
        from flitfancy_sensors import parse_sensor_csv_line, public_environment_rows
        server._store.initialize()
        fields = ['1000', '1', '6', 'CH6 BLE-HR', '1'] + ['NA'] * 23
        fields += ['250', '3', '0', '1.3.5', '5', 'independent-v1', 'NA', '-58',
                   '76', '1', 'NA', 'streaming']
        assert len(fields) == 40
        parsed = parse_sensor_csv_line('CSV,' + ','.join(fields))
        row = server.ingest_json(parsed)
        assert row['channel'] == 'CH6' and row['heart_rate_bpm'] == 76
        assert row['hr_connected'] == 1 and row['hr_contact'] is None
        assert row['hr_state'] == 'streaming' and row['schema_version'] == 5
        # Invalid snapshots must not pull down history means or produce zero heartbeats.
        server.ingest_json({**parsed, 'ok': 0, 'heart_rate_bpm': 999})
        environment = server.ingest_json({'channel': 'CH0', 'sensor': 'CH0 SHT41', 'temp_c': 25})
        buckets = server.compute_history_buckets(24, 'CH6')
        assert buckets[0]['heart_rate_bpm'] == 76
        assert buckets[0]['heart_rate_bpm_min'] == 76 and buckets[0]['heart_rate_bpm_max'] == 76
        assert public_environment_rows([row, environment]) == [environment]

        class Handler(server.Handler):
            def _send(self, status, payload, *_args, **_kwargs):
                self.result = (status, payload)
        handler = object.__new__(Handler)
        handler._api_get('/api/sensors/latest')
        assert all(item['channel'] != 'CH6' for item in handler.result[1]['rows'])
        handler._api_get('/api/sensors/history')
        assert all(item['channel'] != 'CH6' for item in handler.result[1]['rows'])
        handler._api_get('/api/sensors/history', 'channel=CH6&hours=24')
        assert handler.result[0] == 403
        handler._api_get('/api/sensors/heart-rate')
        assert len(handler.result[1]['rows']) == 1 and handler.result[1]['rows'][0]['channel'] == 'CH6'
        handler._api_get('/api/sensors/heart-rate/history', 'hours=24')
        assert handler.result[1]['buckets'][0]['heart_rate_bpm'] == 76
        with mock.patch.object(server, 'worker_post', return_value=(True, 'ok')) as sender:
            assert server.sync_public_sensors([row, environment])
            assert sender.call_args.args[1]['rows'] == [environment]
            sender.reset_mock()
            assert server.sync_public_sensors([row]) is False
            sender.assert_not_called()
            server.sync_public_history()
            assert all(item['channel'] != 'CH6' for item in sender.call_args.args[1]['rows'])
        with mock.patch.object(server._sensor_sync_queue, 'enqueue') as enqueue:
            server.queue_public_sensor_sync([row, environment])
            assert enqueue.call_args.args[0] == [environment]
        assert parse_sensor_csv_line('CSV,' + ','.join(fields[:36])) is not None
        print('Heart-rate schema, local persistence/history, private routes and public-sync isolation passed')


if __name__ == '__main__':
    run()
