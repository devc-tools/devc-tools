# Completion on a fresh line "x = pd." appended via didChange; prints item count and first labels.
import json, os, pathlib, subprocess, sys, threading, time
root = pathlib.Path(sys.argv[1]); f = root / sys.argv[2]; argv = sys.argv[sys.argv.index('--') + 1:]
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=str(root))
pend = {}
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
        m = json.loads(p.stdout.read(int(h['content-length'])))
        if 'id' in m and 'method' in m: send({'jsonrpc': '2.0', 'id': m['id'], 'result': None})
        elif 'id' in m and m['id'] in pend: pend[m['id']][1] = m; pend[m['id']][0].set()
threading.Thread(target=rd, daemon=True).start()
n = [0]
def req(meth, prm):
    n[0] += 1; e = threading.Event(); pend[n[0]] = [e, None]; send({'jsonrpc': '2.0', 'id': n[0], 'method': meth, 'params': prm}); e.wait(60); return pend[n[0]][1]
req('initialize', {'processId': os.getpid(), 'rootUri': root.as_uri(), 'workspaceFolders': [{'uri': root.as_uri(), 'name': 'r'}],
                   'capabilities': {'textDocument': {'completion': {'completionItem': {'snippetSupport': True}}}}})
send({'jsonrpc': '2.0', 'method': 'initialized', 'params': {}})
text = f.read_text() + '\nx = ' + os.environ.get('EXPR', 'pd.')
send({'jsonrpc': '2.0', 'method': 'textDocument/didOpen', 'params': {'textDocument': {'uri': f.as_uri(), 'languageId': 'python', 'version': 1, 'text': text}}})
time.sleep(int(os.environ.get('WAIT', '3')))
lines = text.split('\n')
for trig in [{'triggerKind': 2, 'triggerCharacter': '.'}, {'triggerKind': 1}]:
    r = req('textDocument/completion', {'textDocument': {'uri': f.as_uri()}, 'position': {'line': len(lines) - 1, 'character': len(lines[-1])}, 'context': trig})
    res = r.get('result') or []; items = res.get('items', []) if isinstance(res, dict) else res
    print(trig, len(items), [i['label'] for i in items[:6]], 'error' in r and r['error'] or '')
p.kill()
