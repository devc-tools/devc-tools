"""Does a language server notice an on-disk edit to a file that is NOT open, with a client that
does not advertise workspace/didChangeWatchedFiles?

usage: watch_check.py --root DIR --open REL --edit REL --new-text TEXT [--lang ID]
                      [--settings JSON] [--init JSON] -- server argv...
Opens --open, waits for its diagnostics, rewrites --edit on disk with --new-text (restored after),
then waits up to 30 s for --open's error count to change. Prints NOTICED or NOT NOTICED.
"""
import argparse, json, os, pathlib, subprocess, sys, threading, time

ap = argparse.ArgumentParser()
ap.add_argument('--root', required=True); ap.add_argument('--open', required=True)
ap.add_argument('--edit', required=True); ap.add_argument('--new-text', required=True)
ap.add_argument('--lang', default='typescript'); ap.add_argument('--settings', default='{}')
ap.add_argument('--init', default='{}'); ap.add_argument('--ready-wait', type=float, default=0)
i = sys.argv.index('--'); a = ap.parse_args(sys.argv[1:i]); argv = sys.argv[i + 1:]
root = pathlib.Path(a.root).resolve(); fa = root / a.open; fb = root / a.edit; uri = fa.as_uri()
settings = json.loads(a.settings); t0 = time.time()
def log(*x): print(f'[{time.time()-t0:6.1f}s]', *x, flush=True)
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(root))
pend = {}; nid = [0]; diags = {}; ev = threading.Event(); ready = threading.Event()
def send(m):
    b = json.dumps(m).encode(); p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()
def req(meth, prm, timeout=60):
    nid[0] += 1; k = nid[0]; e = threading.Event(); pend[k] = [e, None]
    send({'jsonrpc': '2.0', 'id': k, 'method': meth, 'params': prm}); e.wait(timeout); return pend[k][1] or {}
def section(name):
    cur = settings
    for part in (name or '').split('.'):
        if part: cur = cur.get(part) if isinstance(cur, dict) else None
    return cur
def rd():
    while True:
        h = {}
        while True:
            l = p.stdout.readline()
            if not l: return
            l = l.strip()
            if not l: break
            if b':' in l: k, v = l.decode().split(':', 1); h[k.lower()] = v.strip()
        if 'content-length' not in h: continue
        m = json.loads(p.stdout.read(int(h['content-length'])))
        if 'id' in m and 'method' in m:
            r = [section(it.get('section')) for it in m['params']['items']] if m['method'] == 'workspace/configuration' else None
            if m['method'] == 'client/registerCapability':
                for reg in m['params'].get('registrations', []):
                    if reg['method'] == 'workspace/didChangeWatchedFiles': log('server asked to register file watchers (client did not advertise support)')
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': r})
        elif 'id' in m and m['id'] in pend: pend[m['id']][1] = m; pend[m['id']][0].set()
        elif m.get('method') == 'textDocument/publishDiagnostics' and m['params']['uri'] == uri:
            diags[uri] = m['params']['diagnostics']; ev.set()
        elif m.get('method') == 'language/status' and m['params'].get('type') == 'ServiceReady': ready.set()
threading.Thread(target=rd, daemon=True).start()
r = req('initialize', {'processId': None, 'rootUri': root.as_uri(), 'workspaceFolders': [{'uri': root.as_uri(), 'name': 'r'}],
    'capabilities': {'textDocument': {'publishDiagnostics': {}, 'diagnostic': {}},
                     'workspace': {'configuration': True, 'workspaceFolders': True,
                                   **({'didChangeWatchedFiles': {'dynamicRegistration': True}} if os.environ.get('NOTIFY') else {})}},
    'initializationOptions': json.loads(a.init)}, 300)
pull = bool(r.get('result', {}).get('capabilities', {}).get('diagnosticProvider'))
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
if settings: send({'jsonrpc': '2.0', 'method': 'workspace/didChangeConfiguration', 'params': {'settings': settings}})
if a.ready_wait: ready.wait(a.ready_wait)
send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri, 'languageId': a.lang, 'version': 1, 'text': fa.read_text()}}})
def errors():
    if pull:
        d = req('textDocument/diagnostic', {'textDocument': {'uri': uri}}).get('result') or {}
        return [x['message'] for x in d.get('items', []) if x.get('severity', 1) == 1]
    return [x['message'] for x in diags.get(uri, []) if x.get('severity', 1) == 1]
if not pull: ev.wait(120)
time.sleep(3); before = errors(); log('errors before:', before)
old = fb.read_text(); fb.write_text(a.new_text); log('edited', a.edit, 'on disk')
if os.environ.get('NOTIFY'):
    send({'jsonrpc': '2.0', 'method': 'workspace/didChangeWatchedFiles', 'params': {'changes': [{'uri': fb.as_uri(), 'type': 2}]}}); log('sent didChangeWatchedFiles')
after = before
try:
    for _ in range(30):
        time.sleep(1); after = errors()
        if after != before: break
finally:
    fb.write_text(old)
log('errors after:', after[:2]); log('NOTICED' if after != before else 'NOT NOTICED')
p.kill()
