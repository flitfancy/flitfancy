"""Opt-in bridge timing on generated files in an isolated NAS test directory.

No real uploads or service state are touched. The configured credentials are
read privately; only timings and operation counts are printed.
"""
import argparse
import hashlib
import io
import json
import logging
import subprocess
import threading
from dataclasses import fields
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from flitfancy_bridge import BridgeService, SMBStorage
from flitfancy_http import HttpDependencies, create_handler


def through_ui(service, paths, body):
    deps = {field.name: lambda *a, **kw: None for field in fields(HttpDependencies)}
    deps.update(bridge_service=service, now_iso=lambda: 'benchmark',
                admin_token_valid=lambda token, ip: token == 'test-password-perf')
    handler = create_handler(HttpDependencies(**deps))
    handler.log_message = lambda *args: None
    server = ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # Drive the shipped UI module against real HTTP and NAS. DOM-only controls
    # are inert fixtures; the transport, hashing and queue are production code.
    javascript = r'''
import fs from 'node:fs'; import vm from 'node:vm'; import assert from 'node:assert/strict';
const input=JSON.parse(process.argv[2]), window={};
for(const name of ['bridge-files','bridge-hash','console-bridge']) vm.runInNewContext(fs.readFileSync('docs/assets/'+name+'.js','utf8'),{window,Blob,setTimeout});
const nodes=new Map(), get=name=>{
 if(!nodes.has(name))nodes.set(name,{hidden:false,value:'',textContent:'',disabled:false,files:[],listeners:{},click(){},addEventListener(n,f){this.listeners[n]=f;},fire(n,e={}){return this.listeners[n]?.(e);}});
 return nodes.get(name);
};
const panel={querySelector:s=>get(s.match(/"([^"]+)"/)[1])};let requests=0;
const module=window.FlitFancyConsoleBridge.create({query:()=>panel,isAdmin:()=>true,isServerOnline:()=>true,async request(path,options={}){
 requests++;
 const response=await fetch('http://127.0.0.1:'+input.port+path,{...options,headers:{Authorization:'Bearer test-password-perf','Content-Type':'application/json',...options.headers}});
 if(!response.ok)throw Error('HTTP '+response.status);
 return response.json();
}});
module.start();await module.refresh();requests=0;
get('folder').files=input.paths.map(path=>{const f=new Blob([input.body]);Object.defineProperties(f,{name:{value:path.split('/').at(-1)},webkitRelativePath:{value:path}});return f;});
await get('folder').fire('change'); const start=performance.now(); await get('send').fire('click');
assert.equal(get('batch-progress').value,1,'folder queue must finish');
console.log(JSON.stringify({ui_seconds:(performance.now()-start)/1000,http_requests:requests}));
'''
    try:
        values = json.dumps({'port': server.server_port, 'paths': paths, 'body': body.decode('ascii')})
        result = subprocess.run(['node', '--input-type=module', '-', values], input=javascript, text=True,
                                encoding='utf-8', cwd=ROOT, capture_output=True, timeout=90)
        if result.returncode:
            raise RuntimeError('UI benchmark did not complete')
        return json.loads(result.stdout)
    finally:
        server.shutdown()
        server.server_close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--files', type=int, default=12)
    parser.add_argument('--depth', type=int, default=5)
    parser.add_argument('--max-seconds', type=float)
    parser.add_argument('--batch', action='store_true', help='Use the small-file batch endpoint semantics')
    parser.add_argument('--ui', action='store_true', help='Exercise the shipped UI queue over real HTTP')
    args = parser.parse_args()
    if not 1 <= args.files <= 64 or not 0 <= args.depth <= 8:
        parser.error('Use 1-64 files and 0-8 directory levels')
    if ((args.batch or args.ui) and args.depth < 1) or (args.batch and not args.ui and args.files > 32):
        parser.error('A batch needs a folder and at most 32 files')
    logging.getLogger('smbprotocol.transport').setLevel(logging.ERROR)
    settings = json.loads((ROOT / 'backend/ai_local.json').read_text(encoding='utf-8'))['nas_bridge'].copy()
    settings['root'] += '/bridge-perf-' + uuid4().hex
    parent = '/'.join('level%d' % i for i in range(args.depth))
    paths = [(parent + '/' if parent else '') + '%d.bin' % i for i in range(args.files)]
    counts, seconds = {}, {}

    class Client:
        def __init__(self, delegate):
            self.delegate = delegate
        def __getattr__(self, name):
            value = getattr(self.delegate, name)
            if name not in {'stat', 'mkdir', 'open_file', 'rename', 'remove'}:
                return value
            def call(*a, **kw):
                start = time.perf_counter()
                try:
                    return value(*a, **kw)
                finally:
                    counts[name] = counts.get(name, 0) + 1
                    seconds[name] = seconds.get(name, 0) + time.perf_counter() - start
            return call

    class MeasuredStorage(SMBStorage):
        def __init__(self, config):
            super().__init__(config)
            self.client = Client(self.client)

    body = b'bridge benchmark\n' * 64
    elapsed = None
    try:
        with tempfile.TemporaryDirectory(prefix='bridge-perf-state-') as state:
            service = BridgeService(lambda: {'nas_bridge': settings}, lambda _: None, state, MeasuredStorage)
            if args.ui and not args.batch:
                original_config = service.config
                service.config = lambda: {**original_config(), 'batch_upload': False}
            try:
                if parent and not args.ui:
                    task = service.directories({'paths': [parent]})
                    service.thread.join(30)
                    assert service.status(task['id'])['state'] == 'succeeded', 'test directory preparation failed'
                counts.clear(); seconds.clear()
                start = time.perf_counter()
                manifest = [{'path': path, 'size': len(body), 'sha256': hashlib.sha256(body).hexdigest()} for path in paths]
                ui = through_ui(service, paths, body) if args.ui else {}
                for entries in ([] if args.ui else [manifest] if args.batch else [[entry] for entry in manifest]):
                    task = service.begin_batch({'folder_root': parent.split('/')[0], 'files': entries}) if args.batch else service.begin(entries[0])
                    payload = body * len(entries)
                    service.chunk(task['id'], 0, len(payload), io.BytesIO(payload))
                    service.commit(task['id'])
                    service.thread.join(30)
                    assert service.status(task['id'])['state'] == 'succeeded', 'benchmark file transfer failed'
                elapsed = ui.get('ui_seconds', time.perf_counter() - start)
                verifier = SMBStorage(settings)
                try:
                    for path in paths:
                        with verifier.open(path, 'rb') as handle:
                            assert handle.read() == body, 'independent NAS readback mismatch'
                finally:
                    verifier.close()
                print(json.dumps({'files': args.files, 'bytes_per_file': len(body), 'depth': args.depth, 'batch': args.batch,
                                  'elapsed_seconds': round(elapsed, 3), 'files_per_second': round(args.files / elapsed, 2),
                                  **({'http_requests': ui['http_requests']} if ui else {}),
                                  'verified_files': len(paths),
                                  'calls': counts, 'call_seconds': {k: round(v, 3) for k, v in seconds.items()}}))
            finally:
                service.close()
    finally:
        storage = SMBStorage(settings)
        try:
            # Only the generated, exactly enumerated paths are removed.
            for path in paths:
                try:
                    storage.remove(path)
                except FileNotFoundError:
                    pass
            for depth in range(args.depth, -1, -1):
                suffix = '/'.join(parent.split('/')[:depth]) if depth else ''
                remote = storage.base + '\\' + (settings['root'] + ('/' + suffix if suffix else '')).replace('/', '\\')
                try:
                    storage.client.rmdir(remote, **storage.options)
                except FileNotFoundError:
                    pass
        finally:
            storage.close()
    if args.max_seconds is not None and elapsed > args.max_seconds:
        raise SystemExit('FAIL: folder transfer exceeded %.2f seconds' % args.max_seconds)


if __name__ == '__main__':
    main()
