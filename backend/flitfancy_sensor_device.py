"""Authenticated website proxy for the fixed FIREFLY-SENSE device on the LAN."""
import http.client
import ipaddress
import json
import os
import re
import threading

MAX_FIRMWARE_BYTES = 0x640000
DEVICE_MARKER = b'FIREFLY-SENSE-N16R8-OTA1'.ljust(32, b'\0')
DEVICE_ERRORS = {
    'wrong-device-image': '请选择 FIREFLY-SENSE 整板应用固件',
    'image-too-small': '固件文件过小', 'image-too-large': '固件超出设备可用空间',
    'length-mismatch': '固件传输长度不一致', 'incomplete-upload': '固件上传不完整',
    'image-verification-failed': '固件校验失败，设备继续运行当前版本',
    'flash-begin-failed': '无法准备设备升级分区', 'flash-write-failed': '固件写入失败',
    'request-rejected': '设备升级请求失效，请重试', 'no-ota-partition': '设备缺少 OTA 分区',
}


class SensorDeviceError(RuntimeError):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class SensorDeviceService:
    def __init__(self, host=None, port=80):
        value = str(host or os.environ.get('FLITFANCY_SENSOR_DEVICE_IP') or '192.168.1.33')
        address = ipaddress.ip_address(value)
        if address.version != 4 or not address.is_private or address.is_unspecified or address.is_multicast:
            raise ValueError('感知板地址必须是固定的本地 IPv4 地址')
        self.host, self.port = str(address), int(port)
        self._lock = threading.Lock()
        self._last_status = {}

    def _connection(self, timeout=8):
        return http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    @staticmethod
    def _decode(response):
        raw = response.read(65537)
        if len(raw) > 65536:
            raise SensorDeviceError('感知板返回内容异常')
        try:
            data = json.loads(raw.decode('utf-8'))
        except (ValueError, UnicodeDecodeError) as exc:
            raise SensorDeviceError('感知板返回格式异常') from exc
        if not isinstance(data, dict):
            raise SensorDeviceError('感知板返回格式异常')
        if not 200 <= response.status < 300 or data.get('ok') is False:
            raise SensorDeviceError(DEVICE_ERRORS.get(data.get('error'), '感知板升级请求失败'),
                                    response.status if 400 <= response.status < 600 else 502)
        return data

    def _device(self):
        connection = self._connection()
        try:
            connection.request('GET', '/device')
            data = self._decode(connection.getresponse())
            if (data.get('model') != 'FIREFLY-SENSE N16R8' or
                not re.fullmatch(r'[0-9a-f]{32}', str(data.get('ota_nonce', ''))) or
                data.get('boot_partition') not in ('app0', 'app1') or
                not isinstance(data.get('max_firmware_bytes'), int) or
                not 320 <= data['max_firmware_bytes'] <= MAX_FIRMWARE_BYTES):
                raise SensorDeviceError('当前设备不支持感知板固件升级', 409)
            return data
        finally:
            connection.close()

    @staticmethod
    def _public(data):
        return {key: data.get(key) for key in (
            'model', 'firmware_version', 'schema_version', 'uptime_ms',
            'boot_partition', 'ota_supported', 'max_firmware_bytes')}

    def status(self):
        if not self._lock.acquire(blocking=False):
            return {'available': True, 'board_connected': bool(self._last_status),
                    'busy': True, **self._last_status}
        try:
            self._last_status = self._public(self._device())
            return {'available': True, 'board_connected': True, 'busy': False, **self._last_status}
        except (OSError, http.client.HTTPException, SensorDeviceError):
            return {'available': False, 'board_connected': False, 'busy': False,
                    'error': '感知板未连接或当前固件不支持 OTA'}
        finally:
            self._lock.release()

    def upload_firmware(self, stream, length):
        if not isinstance(length, int) or not 320 <= length <= MAX_FIRMWARE_BYTES:
            raise SensorDeviceError('请选择不超过 6.25 MiB 的感知板应用固件', 413)
        if not self._lock.acquire(blocking=False):
            raise SensorDeviceError('感知板正在处理升级，请稍后重试', 409)
        connection = None
        try:
            prefix = stream.read(320)
            if len(prefix) != 320:
                raise SensorDeviceError('固件上传不完整', 400)
            if (prefix[0] != 0xe9 or prefix[12:14] != b'\x09\0' or prefix[23] != 1 or
                prefix[288:320] != DEVICE_MARKER):
                raise SensorDeviceError('请选择 FIREFLY-SENSE 整板应用固件', 400)
            device = self._device()
            if not device.get('ota_supported') or length > device['max_firmware_bytes']:
                raise SensorDeviceError('固件大小超出设备可用空间或当前设备不支持 OTA', 409)
            self._last_status = self._public(device)
            connection = self._connection(90)
            connection.putrequest('POST', '/device/firmware')
            connection.putheader('Content-Type', 'application/octet-stream')
            connection.putheader('Content-Length', str(length))
            connection.putheader('X-FFS-OTA-Token', device['ota_nonce'])
            connection.endheaders()
            connection.send(prefix)
            received = len(prefix)
            read_chunk = getattr(stream, 'read1', stream.read)
            while received < length:
                chunk = read_chunk(min(65536, length - received))
                if not chunk:
                    raise SensorDeviceError('固件上传不完整', 400)
                connection.send(chunk)
                received += len(chunk)
            self._decode(connection.getresponse())
            return {'ok': True, 'rebooting': True, 'previous_partition': device['boot_partition']}
        except SensorDeviceError:
            raise
        except TimeoutError as exc:
            raise SensorDeviceError('固件上传停滞，请重新选择文件', 408) from exc
        except (OSError, http.client.HTTPException) as exc:
            raise SensorDeviceError('感知板暂不可用，请检查设备连接', 503) from exc
        finally:
            if connection is not None:
                connection.close()
            self._lock.release()
