"""Generic stdio LSP probe: one file, hover/definition/completion, push or pull diagnostics,
a planted error, and server RSS.

usage: lsp_generic.py --root DIR --file REL --at TEXT [--complete-after TEXT] [--lang ID]
                      [--plant TEXT] [--settings JSON] [--init JSON] -- server argv...
`--at` is a substring in the file; hover and definition go 1 character into it.
`--complete-after` is a substring ending in a trigger (e.g. `foo.`); completion is requested
right after it. `--plant` is a line of code appended at the end of the file to make an error.
"""
import argparse, json, os, pathlib, subprocess, sys, threading, time

ap = argparse.ArgumentParser()
ap.add_argument('--root', required=True); ap.add_argument('--file', required=True)
ap.add_argument('--at', required=True); ap.add_argument('--complete-after')
ap.add_argument('--lang', default='typescript'); ap.add_argument('--plant')
ap.add_argument('--settings', default='{}'); ap.add_argument('--init', default='{}')
ap.add_argument('--timeout', type=float, default=180)
i = sys.argv.index('--'); a = ap.parse_args(sys.argv[1:i]); argv = sys.argv[i + 1:]
root = pathlib.Path(a.root).resolve(); f = root / a.file; uri = f.as_uri()
settings = json.loads(a.settings)
t0 = time.time()
def log(*x): print(f'[{time.time()-t0:6.1f}s]', *x, flush=True)

p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=open(os.environ.get('PROBE_STDERR', '/dev/null'), 'w'), cwd=str(root))
lock = threading.Lock(); pending = {}; nid = [0]; diags = {}; diag_ev = threading.Event()

def send(m):
    b = json.dumps(m).encode()
    with lock: p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()
def request(method, params, timeout=60):
    nid[0] += 1; k = nid[0]; ev = threading.Event(); pending[k] = [ev, None]
    send({'jsonrpc': '2.0', 'id': k, 'method': method, 'params': params})
    if not ev.wait(timeout): return {'error': 'timeout'}
    return pending.pop(k)[1]
def notify(method, params): send({'jsonrpc': '2.0', 'method': method, 'params': params})
def section(name):
    cur = settings
    for part in (name or '').split('.'):
        if not part: continue
        cur = cur.get(part) if isinstance(cur, dict) else None
    return cur

def reader():
    while True:
        h = {}
        while True:
            line = p.stdout.readline()
            if not line: log('SERVER EXITED', p.poll()); return
            line = line.strip()
            if not line: break
            if b':' not in line: log('STDOUT-NOISE', line[:160]); continue
            k, v = line.decode().split(':', 1); h[k.lower()] = v.strip()
        if 'content-length' not in h: continue
        m = json.loads(p.stdout.read(int(h['content-length'])))
        if 'id' in m and 'method' in m:
            res = None
            if m['method'] == 'workspace/configuration':
                res = [section(it.get('section')) for it in m['params']['items']]
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': res})
        elif 'id' in m:
            if m['id'] in pending: pending[m['id']][1] = m; pending[m['id']][0].set()
        elif m.get('method') == 'textDocument/publishDiagnostics':
            diags[m['params']['uri']] = m['params']['diagnostics']; diag_ev.set()
        elif m.get('method') == 'window/logMessage' and m['params'].get('type', 4) <= 1:
            log('ERRLOG', m['params']['message'][:200])
threading.Thread(target=reader, daemon=True).start()

def rss_mb():
    pids = [str(p.pid)]; i = 0
    while i < len(pids):
        pids += subprocess.run(['pgrep', '-P', pids[i]], capture_output=True, text=True).stdout.split(); i += 1
    tot = 0
    for pid in pids:
        try: tot += int([l for l in open(f'/proc/{pid}/status') if l.startswith('VmRSS')][0].split()[1])
        except Exception: pass
    return tot // 1024

r = request('initialize', {
    'processId': os.getpid(), 'rootUri': root.as_uri(), 'rootPath': str(root),
    'workspaceFolders': [{'uri': root.as_uri(), 'name': root.name}],
    'capabilities': {
        'textDocument': {'completion': {'completionItem': {'snippetSupport': True}},
                         'hover': {'contentFormat': ['markdown', 'plaintext']},
                         'publishDiagnostics': {}, 'diagnostic': {'dynamicRegistration': False},
                         'synchronization': {'didSave': True}},
        'workspace': {'configuration': True, 'workspaceFolders': True},
        'window': {'workDoneProgress': True}},
    'initializationOptions': json.loads(a.init)}, timeout=120)
if 'error' in r: log('INIT ERROR', json.dumps(r)[:300]); p.kill(); sys.exit(1)
caps = r['result']['capabilities']; info = r['result'].get('serverInfo', {})
pull = bool(caps.get('diagnosticProvider'))
log('server', info.get('name'), info.get('version'), '| pull diagnostics' if pull else '| push diagnostics',
    '| features:', ','.join(k.replace('Provider', '') for k, v in sorted(caps.items()) if k.endswith('Provider') and v))
notify('initialized', {})
if settings: notify('workspace/didChangeConfiguration', {'settings': settings})

text = f.read_text(); lines = text.split('\n')
def pos_of(sub, after=False, nth=0):
    off = -1
    for _ in range(nth + 1): off = text.index(sub, off + 1)
    off += len(sub) if after else 1
    ln = text.count('\n', 0, off); col = off - (text.rfind('\n', 0, off) + 1)
    return {'line': ln, 'character': col}
notify('textDocument/didOpen', {'textDocument': {'uri': uri, 'languageId': a.lang, 'version': 1, 'text': text}})

def errors_now():
    if pull:
        d = request('textDocument/diagnostic', {'textDocument': {'uri': uri}}, timeout=120).get('result') or {}
        return [x for x in d.get('items', []) if x.get('severity', 1) == 1]
    return [x for x in diags.get(uri, []) if x.get('severity', 1) == 1]

# Push servers publish once the project is loaded; wait for that first.
if not pull:
    diag_ev.wait(a.timeout); log('first diagnostics published')
tp = pos_of(a.at); hv = None
while time.time() - t0 < a.timeout:
    hv = request('textDocument/hover', {'textDocument': {'uri': uri}, 'position': tp}, timeout=120).get('result')
    if hv and 'loading' not in json.dumps(hv): break
    time.sleep(1)
log('hover', json.dumps(hv)[:220] if hv else 'EMPTY')
d = request('textDocument/definition', {'textDocument': {'uri': uri}, 'position': tp}).get('result')
d = d if isinstance(d, list) else [d] if d else []
log('definition', [ (x.get('uri') or x.get('targetUri', '')).replace(root.as_uri(), '<root>')[-110:] for x in d][:2] or 'NONE')
if a.complete_after:
    tc = time.time()
    c = request('textDocument/completion', {'textDocument': {'uri': uri}, 'position': pos_of(a.complete_after, after=True),
                                            'context': {'triggerKind': 2, 'triggerCharacter': a.complete_after[-1]}}).get('result') or []
    items = c.get('items', []) if isinstance(c, dict) else c
    items = sorted(items, key=lambda x: x.get('sortText') or x['label'])
    log(f'completion {len(items)} items in {time.time()-tc:.2f}s', [x['label'] for x in items[:10]])
if not pull: diag_ev.wait(30); time.sleep(3)
base = errors_now()
log('errors in file before plant:', len(base), [x['message'][:100] for x in base[:4]])
if a.plant:
    diags.pop(uri, None); diag_ev.clear(); tp0 = time.time()
    notify('textDocument/didChange', {'textDocument': {'uri': uri, 'version': 2},
                                      'contentChanges': [{'text': text + '\n' + a.plant + '\n'}]})
    got = []
    while time.time() - tp0 < 30:
        if not pull: diag_ev.wait(30 - (time.time() - tp0)); diag_ev.clear()
        got = errors_now()
        if len(got) > len(base): break
        if pull: time.sleep(0.5)
    new = [x for x in got if x['range']['start']['line'] >= len(lines)]
    log(f'planted error reported: {bool(new)} in {time.time()-tp0:.2f}s', [x['message'][:100] for x in new[:2]])
log('server RSS MB', rss_mb())
nid[0] += 1; send({'jsonrpc': '2.0', 'id': nid[0], 'method': 'shutdown'}); time.sleep(0.5); send({'jsonrpc': '2.0', 'method': 'exit'}); time.sleep(1); p.kill()
