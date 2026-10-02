"""Resource metadata editing through real HTTP with disposable files and a fake publisher."""
import copy
import hashlib
import json
import os
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from dataclasses import fields
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from flitfancy_http import HttpDependencies, create_handler
from flitfancy_resources import ResourceService


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix='flitfancy-resource-edit-') as directory:
        docs = Path(directory) / 'docs'
        docs.mkdir()
        published = []
        class Resources(ResourceService):
            def publish(self):
                published.append(True)
                return True, 'fixture publication only'
        service = Resources(str(docs), lambda: '2026-10-02T12:00:00+08:00')
        versions = []
        for index in (1, 2):
            relative = 'files/res-fixture/v%d.zip' % index
            path = docs / 'resources' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            data = b'fixture download ' + str(index).encode()
            path.write_bytes(data)
            versions.append({'label':str(index)+'.0', 'date':'2026-10-01T12:00:00+08:00',
                             'note':'原更新说明', 'file':relative, 'sha256':hashlib.sha256(data).hexdigest(), 'size':len(data)})
        original = {'id':'res-fixture', 'group':'naturecraft', 'title':'感知板资料',
                    'desc':'原简介', 'details':'原详情\n第二行', 'versions':versions, 'custom':'preserved'}
        other = {'id':'res-other', 'group':'firefly', 'title':'其他资料', 'desc':'', 'details':'', 'versions':[]}
        service._save_manifest([copy.deepcopy(original), other])
        def unexpected(*args, **kwargs):
            raise AssertionError('Unexpected fixture dependency')
        deps = {field.name: unexpected for field in fields(HttpDependencies)}
        deps.update(resource_service=service,
                    site_root=str(Path(__file__).resolve().parents[1] / 'docs'),
                    mime={'.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8',
                          '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
                          '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2'},
                    admin_token_valid=lambda token, ip: token == 'resource-fixture-session',
                    admin_login=lambda ip, name, password: (True, 'resource-fixture-session')
                        if name == 'preview' and password == 'resource-preview-fixture' else (False, 'fixture login rejected'),
                    admin_logout=lambda token: None)
        class Handler(create_handler(HttpDependencies(**deps))):
            def log_message(self, *_args):
                pass
            def do_GET(self):
                if urllib.parse.urlparse(self.path).path == '/resources/manifest.json':
                    self._send(200, service.load_manifest())
                else:
                    super().do_GET()
        http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            yield {'http':http, 'base':'http://127.0.0.1:%d' % http.server_port,
                   'service':service, 'original':original, 'other':other, 'published':published, 'docs':docs}
        finally:
            http.shutdown()
            http.server_close()
            thread.join()


def request(environment, method, path, payload=None, token='resource-fixture-session', expected=200, headers=None):
    request_headers = {'Content-Type':'application/json'}
    if token:
        request_headers['Authorization'] = 'Bearer ' + token
    request_headers.update(headers or {})
    raw = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(environment['base']+path, data=raw, headers=request_headers, method=method)
    try:
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = json.load(response)
        assert response.status == expected, (response.status, body)
        return body


def run():
    with fixture() as environment, mock.patch('flitfancy_resources.subprocess.run', side_effect=AssertionError('Editing must not invoke Git')):
        original = environment['original']
        payload = {'id':original['id'], 'title':'修改后的资料', 'group':'flitfancy',
                   'desc':'新的简介', 'details':'第一行\n第二行 <script>'}
        # Authorization rejects before reading a body. Empty requests verify this
        # boundary without an unread-body TCP reset obscuring the HTTP status.
        request(environment, 'POST', '/api/resources/update', token=None, expected=401)
        request(environment, 'POST', '/api/resources/update',
                headers={'Sec-Fetch-Site':'cross-site'}, expected=403)
        edited = request(environment, 'POST', '/api/resources/update', payload)['entry']
        assert edited['id'] == original['id'] and edited['versions'] == original['versions']
        assert edited['custom'] == 'preserved' and edited['group'] == 'flitfancy'
        assert edited['title'] == payload['title'] and edited['details'] == payload['details']
        for version in original['versions']:
            assert hashlib.sha256((environment['docs']/'resources'/version['file']).read_bytes()).hexdigest() == version['sha256']
        for index in range(3):
            request(environment, 'POST', '/api/resources/update', {**payload, 'title':'重复修改 %d' % index})
        rows = request(environment, 'GET', '/api/resources')['resources']
        assert len(rows) == 2 and rows[1] == environment['other']
        assert len(rows[0]['versions']) == 2
        cleared = request(environment, 'POST', '/api/resources/update', {'id':original['id'], 'desc':'', 'details':''})['entry']
        assert cleared['desc'] == cleared['details'] == '' and cleared['title'] == '重复修改 2'
        protected = request(environment, 'POST', '/api/resources/update', {'id':original['id'], 'title':'字段保护',
                            'versions':[], 'file':'overwrite.zip', 'sha256':'invalid'})['entry']
        assert protected['versions'] == original['versions']
        before = environment['service'].load_manifest()
        for invalid in ({'title':''}, {'group':'unknown'}, {'title':{}}, {'title':'x'*121}, {'desc':'x'*401}, {'details':'x'*6001}):
            request(environment, 'POST', '/api/resources/update', {'id':original['id'], **invalid}, expected=400)
        request(environment, 'POST', '/api/resources/update', {'id':'missing', 'title':'不存在'}, expected=404)
        assert environment['service'].load_manifest() == before
        assert environment['published'] == [], 'metadata saves do not publish automatically'
        request(environment, 'POST', '/api/resources/publish', [], expected=400)
        assert environment['published'] == [], 'invalid publication bodies must be consumed and rejected'
        request(environment, 'POST', '/api/resources/publish', {})
        assert environment['published'] == [True]
        upload = environment['service'].begin_upload({'id':original['id'], 'group':'flitfancy', 'label':'3.0', 'note':'新版本'})
        appended = environment['service'].finalize_upload(upload['token'])
        assert appended['title'] == '字段保护' and len(appended['versions']) == 3
    print('resource editing: authentication, validation, clear fields, stable IDs, unchanged downloads/history, repeated saves and explicit publication passed')


if __name__ == '__main__':
    import sys
    if '--preview' in sys.argv:
        with fixture() as environment:
            print('PREVIEW_URL=' + environment['base'] + '/resources.html#manage', flush=True)
            print('PREVIEW_PID=' + str(os.getpid()), flush=True)
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                pass
    else:
        run()
