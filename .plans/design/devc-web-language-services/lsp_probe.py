"""Minimal stdio LSP client to probe a Java language server against deephaven-core.

usage: lsp_probe.py <root> <ready-timeout-s> -- <server argv...>
Prints timestamped events and the results of a few requests on a known file.
"""
import json, os, subprocess, sys, threading, time, pathlib

root = pathlib.Path(sys.argv[1]).resolve()
ready_timeout = float(sys.argv[2])
argv = sys.argv[sys.argv.index('--') + 1:]
t0 = time.time()
def log(*a):
    print(f'[{time.time()-t0:7.1f}s]', *a, flush=True)

p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(os.environ.get('PROBE_STDERR', '/dev/null'), 'w'))
lock = threading.Lock(); pending = {}; nid = [0]
diags = {}; ready = threading.Event(); statuses = []; progress = {'last': time.time()}

def send(msg):
    b = json.dumps(msg).encode()
    with lock:
        p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()

def request(method, params, timeout=120):
    nid[0] += 1; i = nid[0]; ev = threading.Event(); pending[i] = [ev, None]
    send({'jsonrpc': '2.0', 'id': i, 'method': method, 'params': params})
    if not ev.wait(timeout): return {'error': 'timeout'}
    return pending.pop(i)[1]

def notify(method, params): send({'jsonrpc': '2.0', 'method': method, 'params': params})

def reader():
    f = p.stdout
    while True:
        h = {}
        while True:
            line = f.readline()
            if not line: return
            line = line.strip()
            if not line: break
            if b':' not in line: log('STDOUT-NOISE', line[:200]); continue
            k, v = line.decode().split(':', 1); h[k.lower()] = v.strip()
        if 'content-length' not in h: continue
        m = json.loads(f.read(int(h['content-length'])))
        if 'id' in m and 'method' in m:  # server->client request
            res = None
            if m['method'] == 'workspace/configuration': res = [None] * len(m['params']['items'])
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': res})
        elif 'id' in m:
            if m['id'] in pending: pending[m['id']][1] = m; pending[m['id']][0].set()
        else:
            meth = m['method']; prm = m.get('params', {})
            if meth == 'textDocument/publishDiagnostics':
                diags[prm['uri']] = prm['diagnostics']
            elif meth == 'language/status':
                statuses.append(prm); log('status', prm.get('type'), prm.get('message', '')[:120])
                if prm.get('type') == 'ServiceReady': ready.set()
            elif meth == '$/progress':
                k = prm.get('value', {}).get('kind'); progress[k] = progress.get(k, 0) + 1; progress['last'] = time.time()
                if k in ('begin', 'end'): log('progress', k, prm['value'].get('title', '')[:80], prm['value'].get('message', '')[:60])
            elif meth == 'window/logMessage' and prm.get('type', 4) <= 1:
                log('ERRLOG', prm['message'][:300])
threading.Thread(target=reader, daemon=True).start()

settings = {'java': {
    'import': {'gradle': {'enabled': True, 'wrapper': {'enabled': True},
                           'annotationProcessing': {'enabled': os.environ.get('PROBE_APT', 'false') == 'true'},
                           'arguments': os.environ.get('PROBE_GRADLE_ARGS', '')},
               'maven': {'enabled': False},
               'generatesMetadataFilesAtProjectRoot': False},
    'autobuild': {'enabled': os.environ.get('PROBE_AUTOBUILD', 'true') == 'true'},
    'configuration': {'updateBuildConfiguration': 'automatic',
        'runtimes': [{'name': 'JavaSE-21', 'path': '/usr/local/sdkman/candidates/java/21.0.12-tem', 'default': True}]},
}}
r = request('initialize', {
    'processId': os.getpid(), 'rootUri': root.as_uri(),
    'workspaceFolders': [{'uri': root.as_uri(), 'name': root.name}],
    'capabilities': {'textDocument': {'completion': {'completionItem': {'snippetSupport': True}},
                                      'hover': {'contentFormat': ['markdown', 'plaintext']},
                                      'publishDiagnostics': {}},
                     'workspace': {'configuration': True, 'workspaceFolders': True},
                     'window': {'workDoneProgress': True}},
    'initializationOptions': {'settings': settings, 'extendedClientCapabilities': {'classFileContentsSupport': True},
                              **({'nbcodeCapabilities': {'statusBarMessageSupport': False, 'testResultsSupport': False,
                                                         'showHtmlPageSupport': False, 'wantsJavaSupport': True,
                                                         'wantsGroovySupport': False}} if os.environ.get('PROBE_NB') else {})},
}, timeout=300)
log('initialized', 'error' in r and r['error'] or 'ok')
notify('initialized', {})
if os.environ.get('PROBE_NB'):
    # no ServiceReady: wait until all progress has ended and nothing moved for 30s
    while time.time() - t0 < ready_timeout:
        if progress.get('end', 0) >= progress.get('begin', 0) and progress.get('begin', 0) > 0 and time.time() - progress['last'] > 30: break
        time.sleep(2)
    ready.set()
if not ready.wait(ready_timeout):
    log('NOT READY within timeout')
log('ready')

def rss_mb():
    tot = 0
    for pid in subprocess.run(['pgrep', '-P', str(p.pid)], capture_output=True, text=True).stdout.split() + [str(p.pid)]:
        try: tot += int([l for l in open(f'/proc/{pid}/status') if l.startswith('VmRSS')][0].split()[1])
        except Exception: pass
    return tot // 1024
log('server RSS MB', rss_mb())

if os.environ.get('PROBE_CP'):
    q = root / 'engine/table/src/main/java/io/deephaven/engine/table/impl/QueryTable.java'
    allp = request('workspace/executeCommand', {'command': 'java.project.getAll', 'arguments': []})
    names = [u.rstrip('/').split('/')[-1] for u in (allp.get('result') or [])]
    log('projects', len(names), [n for n in names if n.lower().startswith('util') or n == 'Util'][:20])
    for scope in ['test']:
        cp = request('workspace/executeCommand', {'command': 'java.project.getClasspaths', 'arguments': [q.as_uri(), json.dumps({'scope': scope})]})
        r = cp.get('result') or cp
        ent = r.get('classpaths', []) if isinstance(r, dict) else r
        log('classpath', scope, len(ent))
        for e in ent:
            if 'Util' in e or 'util' in e.split('/')[-3:-1].__str__() or 'proto' in e: log('   ', e.replace(str(root), '<repo>'))
        if not ent: log('   raw', json.dumps(cp)[:400])
    request('shutdown', None, timeout=30); notify('exit', None); time.sleep(2); p.kill(); sys.exit(0)
# Probe file: QueryTable.java in engine-table
f = root / 'engine/table/src/main/java/io/deephaven/engine/table/impl/QueryTable.java'
text = f.read_text(); uri = f.as_uri()
notify('textDocument/didOpen', {'textDocument': {'uri': uri, 'languageId': 'java', 'version': 1, 'text': text}})
lines = text.split('\n')
def find(sub):
    for i, l in enumerate(lines):
        c = l.find(sub)
        if c >= 0: return i, c
ln, col = find('getRowSet().')
log('hover', json.dumps(request('textDocument/hover', {'textDocument': {'uri': uri}, 'position': {'line': ln, 'character': col + 2}}).get('result'))[:300])
d = request('textDocument/definition', {'textDocument': {'uri': uri}, 'position': {'line': ln, 'character': col + 2}})
log('definition', json.dumps(d.get('result'))[:300])
# completion after "getRowSet()."
tc = time.time()
c = request('textDocument/completion', {'textDocument': {'uri': uri}, 'position': {'line': ln, 'character': col + len('getRowSet().')}})
res = c.get('result') or {}
items = res.get('items', res) if isinstance(res, dict) else res
log(f'completion {len(items or [])} items in {time.time()-tc:.2f}s', [i['label'] for i in (items or [])[:8]])
# an annotation-processor (Immutables) generated type: ImmutableXxx usage
for probe in ['Immutable', 'Builder()']:
    pass
# wait for diagnostics to settle: no change in total count for 60s (max 15 min)
last, stable = -1, 0
while stable < 60 and time.time() - t0 < 2400:
    n = sum(len(v) for v in diags.values())
    stable = stable + 5 if n == last else 0; last = n; time.sleep(5)
log('diagnostics settled')
errs = {u: [x for x in ds if x.get('severity') == 1] for u, ds in diags.items()}
errs = {u: e for u, e in errs.items() if e}
log('files with error diagnostics:', len(errs))
import collections, re
cat = collections.Counter(re.sub(r"[A-Z][\w.$]*", "X", x['message'])[:90] for e in errs.values() for x in e)
for k, v in cat.most_common(12): log(f'  {v:6d}  {k}')
byproj = collections.Counter()
for u in errs:
    rel = u.replace(root.as_uri() + '/', '')
    k = rel.split('/src/')[0] + ('  [test]' if '/src/test/' in rel else '  [main]' if '/src/main/' in rel else '')
    byproj[k] += 1
for k, v in byproj.most_common(25): log(f'  BYPROJ {v:5d} {k}')
seen = collections.Counter()
for u, e in errs.items():
    rel = u.replace(root.as_uri() + '/', ''); k = rel.split('/src/')[0] + ('/test' if '/src/test/' in rel else '')
    if k in ('engine/table/test', 'engine/benchmark', 'ssl/config', 'extensions/json', 'extensions/iceberg', 'java-client/session', 'engine/api/test') and seen[k] < 2:
        seen[k] += 1; log('  SAMPLE', k, rel.split('/')[-1], '|', e[0]['message'][:150])
for u, e in list(errs.items())[:8]:
    log('  ', u.replace(root.as_uri(), ''), len(e), e[0]['message'][:140])
log('QueryTable errors:', len(errs.get(uri, [])))
log('server RSS MB', rss_mb())
if os.environ.get('PROBE_VALIDATE'):
    # 1) a planted type error in QueryTable via didChange
    bad = text.replace('public class QueryTable', 'public class QueryTable', 1)
    i = bad.index('{', bad.index('public class QueryTable')) + 1
    bad = bad[:i] + '\n    int devcProbe = "not an int";\n' + bad[i:]
    notify('textDocument/didChange', {'textDocument': {'uri': uri, 'version': 2}, 'contentChanges': [{'text': bad}]})
    if os.environ.get('PROBE_SAVE'): notify('textDocument/didSave', {'textDocument': {'uri': uri}, 'text': bad})
    # 2) files outside the pre-built tree
    others = ['extensions/parquet/table/src/main/java/io/deephaven/parquet/table/metadata/CodecInfo.java',
              'server/src/main/java/io/deephaven/server/session/SessionState.java',
              'DHProcess/src/main/java/io/deephaven/process/BaseboardOshi.java']
    for o in others:
        fo = root / o
        notify('textDocument/didOpen', {'textDocument': {'uri': fo.as_uri(), 'languageId': 'java', 'version': 1, 'text': fo.read_text()}})
    time.sleep(int(os.environ.get('PROBE_VALIDATE_WAIT', '25')))
    for u in [uri] + [(root / o).as_uri() for o in others]:
        ds = diags.get(u)
        log('VALIDATE', u.split('/')[-1], 'no publish' if ds is None else [(d.get('severity'), d['message'][:90]) for d in ds if d.get('severity') == 1][:4])
    log('total published uris', len(diags), 'with any diag', sum(1 for v in diags.values() if v))
request('shutdown', None, timeout=30); notify('exit', None)
time.sleep(2); p.kill()
