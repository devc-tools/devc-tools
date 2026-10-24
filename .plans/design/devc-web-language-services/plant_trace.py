# Opens QueryTable.java, waits, plants a type error via didChange, and logs every
# publishDiagnostics for that file (count of errors + first message) with timestamps.
import json, os, pathlib, subprocess, sys, threading, time
root = pathlib.Path(sys.argv[1]); argv = sys.argv[sys.argv.index('--') + 1:]
f = root / 'engine/table/src/main/java/io/deephaven/engine/table/impl/QueryTable.java'; uri = f.as_uri()
t0 = time.time(); ready = threading.Event(); pend = {}
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
def log(*a): print(f'[{time.time()-t0:6.1f}s]', *a, flush=True)
def send(m):
    b = json.dumps(m).encode(); p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()
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
        elif 'id' in m and m['id'] in pend: pend[m['id']].set()
        elif m.get('method') == 'language/status' and m['params'].get('type') == 'ServiceReady': ready.set()
        elif m.get('method') == 'textDocument/publishDiagnostics' and m['params']['uri'] == uri:
            e = [d for d in m['params']['diagnostics'] if d.get('severity') == 1]
            log('PUBLISH', len(m['params']['diagnostics']), 'diags,', len(e), 'errors', e[0]['message'][:80] if e else '')
threading.Thread(target=rd, daemon=True).start()
ev = threading.Event(); pend[1] = ev
settings = {'java': {'import': {'gradle': {'enabled': True, 'wrapper': {'enabled': True}, 'annotationProcessing': {'enabled': False},
            'arguments': os.environ.get('PROBE_GRADLE_ARGS', '')}, 'maven': {'enabled': False}},
            'autobuild': {'enabled': os.environ.get('PROBE_AUTOBUILD', 'true') == 'true'},
            'configuration': {'runtimes': [{'name': 'JavaSE-21', 'path': '/usr/local/sdkman/candidates/java/21.0.12-tem', 'default': True}]}}}
send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'processId': os.getpid(), 'rootUri': root.as_uri(),
      'workspaceFolders': [{'uri': root.as_uri(), 'name': 'dh'}],
      'capabilities': {'textDocument': {'publishDiagnostics': {}, 'synchronization': {'didSave': True}}, 'workspace': {'configuration': True}},
      'initializationOptions': {'settings': settings}}})
ev.wait(300); send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
ready.wait(900); log('ready')
text = f.read_text()
send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': uri, 'languageId': 'java', 'version': 1, 'text': text}}})
time.sleep(15); log('planting')
i = text.index('{', text.index('public class QueryTable')) + 1
bad = text[:i] + '\n    int devcProbe = "not an int";\n' + text[i:]
send({'jsonrpc': '2.0', 'method': 'textDocument/didChange', 'params': {'textDocument': {'uri': uri, 'version': 2}, 'contentChanges': [{'text': bad}]}})
time.sleep(20); log('done'); p.kill()
