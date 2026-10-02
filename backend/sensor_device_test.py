"""Exercise production streaming against an isolated fake board."""
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from flitfancy_sensor_device import DEVICE_MARKER, MAX_FIRMWARE_BYTES, SensorDeviceError, SensorDeviceService


def run():
    requests = []
    device = {'model': 'FIREFLY-SENSE N16R8', 'firmware_version': '1.3.3', 'schema_version': 4,
              'ota_nonce': 'a' * 32, 'boot_partition': 'app1', 'ota_supported': True,
              'max_firmware_bytes': MAX_FIRMWARE_BYTES, 'uptime_ms': 1000}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def reply(self, data):
            raw = json.dumps(data).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
                pass
        def do_GET(self):
            assert self.path == '/device'
            self.reply(device)
        def do_POST(self):
            self.connection.settimeout(3)
            body = self.rfile.read(int(self.headers['Content-Length']))
            requests.append((self.path, dict(self.headers), body))
            self.reply({'ok': True, 'rebooting': True})
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    service = SensorDeviceService('127.0.0.1', server.server_port)
    image = bytearray(131073)
    image[0] = 0xe9; image[12] = 9; image[23] = 1; image[288:320] = DEVICE_MARKER
    try:
        status = service.status()
        assert status['board_connected'] and status['firmware_version'] == '1.3.3'
        assert 'ota_nonce' not in status
        result = service.upload_firmware(io.BytesIO(image), len(image))
        assert result['ok'] and result['previous_partition'] == 'app1'
        path, headers, received = requests[-1]
        assert path == '/device/firmware' and received == image
        assert headers['X-FFS-OTA-Token'] == device['ota_nonce']
        assert headers['Content-Type'] == 'application/octet-stream'
        count = len(requests)
        for data, length, code in [(b'bad', 3, 413), (b'', MAX_FIRMWARE_BYTES + 1, 413),
                                   (bytes(512), 512, 400), (image[:100], 512, 400)]:
            try:
                service.upload_firmware(io.BytesIO(data), length)
                raise AssertionError('Invalid image accepted')
            except SensorDeviceError as error:
                assert error.status == code
        assert len(requests) == count, 'Invalid files reached board POST'
        service._lock.acquire()
        assert service.status()['busy']
        try:
            service.upload_firmware(io.BytesIO(image), len(image))
            raise AssertionError('Concurrent update accepted')
        except SensorDeviceError as error:
            assert error.status == 409
        finally:
            service._lock.release()
        device['model'] = 'FIREFLY VOICE'
        assert not service.status()['board_connected']
        try:
            service.upload_firmware(io.BytesIO(image), len(image))
            raise AssertionError('Wrong device accepted')
        except SensorDeviceError as error:
            assert error.status == 409
        assert len(requests) == count
        device['model'] = 'FIREFLY-SENSE N16R8'
        try:
            service.upload_firmware(io.BytesIO(image[:512]), 1024)
            raise AssertionError('Truncated transfer accepted')
        except SensorDeviceError as error:
            assert error.status == 400
        assert service.status()['board_connected'], 'Failed transfer retained update lock'
        for host in ('8.8.8.8', 'example.com', '0.0.0.0', '224.0.0.1', '::1'):
            try:
                SensorDeviceService(host)
                raise AssertionError('Non-LAN address accepted')
            except ValueError:
                pass
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=3)
    print('sensor device proxy test ok')


if __name__ == '__main__':
    run()
