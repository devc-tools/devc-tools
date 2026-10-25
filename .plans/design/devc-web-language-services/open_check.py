# Import with the given settings, open files, print their error diagnostics after they settle.
import json, os, pathlib, subprocess, sys, threading, time
root = pathlib.Path(sys.argv[1]); settings = json.load(open(sys.argv[2])); files = sys.argv[3].split(','); argv = sys.argv[sys.argv.index('--') + 1:]
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
diags = {}; ready = threading.Event(); pend = {}; t0 = time.time()
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
        if 'id' in m and 'method' in m: send({'jsonrpc': '2.0', 'id': m['id'], 'result': None})
        elif 'id' in m and m['id'] in pend: pend[m['id']].set()
        elif m.get('method') == 'language/status' and m['params'].get('type') == 'ServiceReady': ready.set()
        elif m.get('method') == 'textDocument/publishDiagnostics': diags[m['params']['uri']] = m['params']['diagnostics']
threading.Thread(target=rd, daemon=True).start()
e = threading.Event(); pend[1] = e
send({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'processId': None, 'rootUri': root.as_uri(),
      'workspaceFolders': [{'uri': root.as_uri(), 'name': 'dh'}], 'capabilities': {'textDocument': {'publishDiagnostics': {}}},
      'initializationOptions': {'settings': settings}}})
e.wait(300); send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}}); ready.wait(1200)
print(f'[{time.time()-t0:.0f}s] ready', flush=True); time.sleep(int(os.environ.get('SETTLE', '0')))
for f in files:
    fp = root / f; send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': fp.as_uri(), 'languageId': 'java', 'version': 1, 'text': fp.read_text()}}})
time.sleep(30)
for f in files:
    errs = [d['message'] for d in diags.get((root / f).as_uri(), []) if d.get('severity') == 1]
    print(f'{f.split("/")[-1]}: {len(errs)} errors', errs[:3], flush=True)
p.kill()
