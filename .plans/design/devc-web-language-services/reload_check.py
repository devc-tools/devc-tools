# Generated folder appears after import: does java/projectConfigurationsUpdate pick it up?
import json, os, pathlib, shutil, subprocess, sys, threading, time
root = pathlib.Path(sys.argv[1]); argv = sys.argv[sys.argv.index('--') + 1:]
gen = root / 'DHProcess/out/production/classes/generated'; hidden = root / 'DHProcess/out/production/classes/generated.hidden'
f = root / 'DHProcess/src/main/java/io/deephaven/process/BaseboardOshi.java'; uri = f.as_uri()
if gen.exists(): gen.rename(hidden)
t0 = time.time(); ready = threading.Event(); pend = {}; nid = [0]
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
def log(*a): print(f'[{time.time()-t0:6.1f}s]', *a, flush=True)
def send(m):
    b = json.dumps(m).encode(); p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()
def req(meth, prm, timeout=120):
    nid[0] += 1; k = nid[0]; e = threading.Event(); pend[k] = [e, None]; send({'jsonrpc': '2.0', 'id': k, 'method': meth, 'params': prm}); e.wait(timeout); return pend[k][1] or {}
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
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': [None] * len(m['params']['items']) if m['method'] == 'workspace/configuration' else None})
        elif 'id' in m and m['id'] in pend: pend[m['id']][1] = m; pend[m['id']][0].set()
        elif m.get('method') == 'language/status' and m['params'].get('type') == 'ServiceReady': ready.set()
        elif m.get('method') == 'textDocument/publishDiagnostics' and m['params']['uri'] == uri:
            e = [d['message'] for d in m['params']['diagnostics'] if d.get('severity') == 1]; log('PUBLISH errors:', e[:2])
threading.Thread(target=rd, daemon=True).start()
settings = {'java': {'import': {'gradle': {'enabled': True, 'wrapper': {'enabled': True}, 'annotationProcessing': {'enabled': False},
            'arguments': os.environ['PROBE_GRADLE_ARGS']}, 'maven': {'enabled': False}}, 'autobuild': {'enabled': False},
            'configuration': {'updateBuildConfiguration': 'automatic', 'runtimes': [{'name': 'JavaSE-21', 'path': '/usr/local/sdkman/candidates/java/21.0.12-tem', 'default': True}]}}}
try:
    req('initialize', {'processId': None, 'rootUri': root.as_uri(), 'workspaceFolders': [{'uri': root.as_uri(), 'name': 'dh'}],
        'capabilities': {'textDocument': {'publishDiagnostics': {}}, 'workspace': {'configuration': True}}, 'initializationOptions': {'settings': settings}}, 300)
    send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}}); ready.wait(900); log('ready')
    send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri, 'languageId': 'java', 'version': 1, 'text': f.read_text()}}})
    time.sleep(10)
    hidden.rename(gen); log('generated folder restored; sending java/projectConfigurationsUpdate for all projects')
    projs = req('workspace/executeCommand', {'command': 'java.project.getAll', 'arguments': []}).get('result') or []
    log('projects:', len(projs))
    send({'jsonrpc': '2.0', 'method': 'java/projectConfigurationsUpdate', 'params': {'identifiers': [{'uri': u} for u in projs]}})
    time.sleep(90)
    # nudge reconcile of the open file
    send({'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {'textDocument': {'uri': uri, 'version': 2}, 'contentChanges': [{'text': f.read_text() + '\n'}]}})
    time.sleep(15); log('done')
finally:
    if hidden.exists() and not gen.exists(): hidden.rename(gen)
    p.kill()
