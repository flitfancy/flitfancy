"""Real HTTP and isolated SQLite regression for editing original anchor cards."""
import json
import os
import re
import tempfile
import threading
import urllib.error
import urllib.request
from unittest import mock
from dataclasses import fields
from http.server import ThreadingHTTPServer

from flitfancy_core import now_iso
from flitfancy_http import HttpDependencies, create_handler
from flitfancy_storage import SQLiteStore


def run():
    import server
    record = {'uid':'legacy-anchor-firefly-brain', 'created_at':now_iso(),
              'anchor_time':'', 'time_precision':'none', 'horizon':'now', 'project':'firefly',
              'title':'测试卡片', 'content':'测试正文', 'badge':'进行中', 'badge_kind':'doing'}
    with mock.patch.object(server._worker_client, 'post', return_value=(False, 'old worker')) as send:
        assert server.sync_public_anchor(record)[0] is False
        assert send.call_args.kwargs['expected_response'] == {
            'precision':'none', 'badge':'进行中', 'badge_kind':'doing'}
    site_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'docs'))
    with open(os.path.join(site_root, 'journal.html'), encoding='utf-8') as source:
        uids = re.findall(r'data-anchor-uid="([a-zA-Z0-9_-]+)"', source.read())
    assert len(uids) == len(set(uids)) == 9
    with tempfile.TemporaryDirectory(prefix='flitfancy-anchor-cards-') as directory:
        store = SQLiteStore(os.path.join(directory, 'fixture.db'))
        store.initialize()
        store.initialize()
        def unexpected(*args, **kwargs):
            raise AssertionError('Unexpected dependency')
        deps = {field.name: unexpected for field in fields(HttpDependencies)}
        deps.update(site_root=site_root, db=store.connect, now_iso=now_iso,
                    admin_token_valid=lambda token, ip: token == 'anchor-fixture-token',
                    sync_pending_anchors=lambda: (0, 'fixture offline'))
        class Handler(create_handler(HttpDependencies(**deps))):
            def log_message(self, *_args):
                pass
        http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        def request(method, path, payload=None, token='anchor-fixture-token', expected=200):
            headers = {'Content-Type':'application/json'}
            if token:
                headers['Authorization'] = 'Bearer ' + token
            raw = None if payload is None else json.dumps(payload).encode()
            req = urllib.request.Request('http://127.0.0.1:%d%s' % (http.server_port, path),
                                         data=raw, headers=headers, method=method)
            try:
                response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=5)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                result = json.load(response)
                assert response.status == expected, (response.status, result)
                return result
        try:
            assert request('GET', '/api/anchors')['rows'] == []
            payload = {'uid':uids[0], 'title':'测试卡片', 'content':'第一行\n第二行',
                       'project':'firefly', 'horizon':'now', 'badge':'已跑通', 'badge_kind':'done'}
            # 鉴权在读 body 前拒绝；空请求避免未读正文导致 Windows TCP reset。
            request('POST', '/api/anchors', token=None, expected=401)
            for uid in uids:
                saved = request('POST', '/api/anchors', {**payload, 'uid':uid})
                assert saved['updated'] and saved['anchor']['precision'] == 'none'
                assert saved['anchor']['time'] == '' and not saved['public_sync']
                assert saved['anchor']['content'] == payload['content']
            updated = request('POST', '/api/anchors', {**payload, 'title':'修改后',
                'project':'skywork', 'badge':'进行中', 'badge_kind':'doing'})
            assert updated['anchor']['badge'] == '进行中'
            assert updated['anchor']['badge_kind'] == 'doing'
            assert updated['anchor']['project'] == 'skywork'
            rows = request('GET', '/api/anchors')['rows']
            assert len(rows) == 9 and sum(row['uid'] == payload['uid'] for row in rows) == 1
            request('POST', '/api/anchors', {**payload, 'uid':'legacy-anchor-unknown'}, expected=404)
            request('POST', '/api/anchors', {**payload, 'badge_kind':'unsafe'}, expected=400)
            ordinary = {key:value for key,value in payload.items() if key not in ('uid','badge','badge_kind')}
            normal = request('POST', '/api/anchors', {**ordinary, 'time':'2026-08-21'}, expected=201)['anchor']
            assert normal['precision'] == 'date' and normal['badge'] == ''
            request('POST', '/api/anchors', {**ordinary, 'uid':normal['uid'],
                'time':'2026-08-22T12:34:56', 'title':'修改普通锚点'})
            assert len(request('GET', '/api/anchors')['rows']) == 10
            connection = store.connect()
            assert connection.execute('SELECT synced FROM anchors WHERE uid=?', (payload['uid'],)).fetchone()[0] == 0
            # 原卡片覆盖记录不能被普通时间线的 200 条上限挤掉。
            dated = [('pagination-anchor-%04d' % index,
                      '2026-10-02T12:00:00+08:00' if index % 2 else '2026-09-01T12:00:00+08:00',
                      index) for index in range(205)]
            connection.executemany(
                """INSERT INTO anchors(uid, created_at, anchor_time, horizon, project, title, content)
                   VALUES(?,?,?,'now','firefly','分页测试','正文')""",
                [(uid, now_iso(), timestamp) for uid, timestamp, _ in dated],
            )
            connection.commit()
            connection.close()
            rows = request('GET', '/api/anchors')['rows']
            expected_dated = [uid for uid, _, _ in sorted(dated, key=lambda row: (row[1], row[2]), reverse=True)[:200]]
            assert [row['uid'] for row in rows if row['uid'] not in uids] == expected_dated
            cards = {row['uid']: row for row in rows if row['uid'] in uids}
            assert len(rows) == 209 and set(cards) == set(uids)
            assert cards[payload['uid']]['title'] == '修改后'
            assert cards[payload['uid']]['badge_kind'] == 'doing'
            assert all(card['time'] == '' and card['precision'] == 'none' for card in cards.values())
        finally:
            http.shutdown()
            http.server_close()
            thread.join()
    print('anchor cards: all nine originals, authentication, undated format, status, idempotent editing, worker confirmation and bounded dated history passed')


if __name__ == '__main__':
    run()
