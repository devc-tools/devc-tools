"""Simulates what VS Code + vscode-java does against JDT LS on deephaven-core, and measures it.

usage: vscode_sim.py <label> <root> <settings-json-file> -- <server argv...>

Phases, each measured until the server is quiet (CPU < 0.15 cores over a 15 s window):
  import   initialize → ServiceReady → quiet
  body     QueryTable.java: open, edit a method body, save (disk write + didSave +
           didChangeWatchedFiles), as VS Code does on Ctrl-S
  struct   Table.java (imported by ~630 files): add a default method, save
  revert   both files back to the original text, save
For each phase: wall seconds, server CPU seconds, publishDiagnostics notifications, files with
errors at the end. Also peak RSS and total GC pause (parsed from -Xlog:gc to $GC_LOG).
Prints one JSON line per phase prefixed RESULT.
"""
import json, os, pathlib, re, subprocess, sys, threading, time

label, root, settings_file = sys.argv[1], pathlib.Path(sys.argv[2]), sys.argv[3]
argv = sys.argv[sys.argv.index('--') + 1:]
settings = json.load(open(settings_file))
TICK = os.sysconf('SC_CLK_TCK')
t0 = time.time()
def log(*a): print(f'[{label} {time.time()-t0:7.1f}s]', *a, flush=True)

bsp_ext = os.environ.get('SIM_BSP')  # vscode-gradle extension dir: emulate its BspProxy
bsp = {}
if bsp_ext:
    import socket, tempfile, uuid
    sockdir = tempfile.mkdtemp(prefix='bsp', dir='/tmp')
    def listen(name):
        path = os.path.join(sockdir, name); s_ = socket.socket(socket.AF_UNIX); s_.bind(path); s_.listen(4); return path, s_
    task_path, task_srv = listen('task.sock'); bs_path, bs_srv = listen('bs.sock'); ls_path, ls_srv = listen('ls.sock')
    def accept_drain(srv):
        while True:
            c, _ = srv.accept()
            threading.Thread(target=lambda: [None for _ in iter(lambda: c.recv(65536), b'')], daemon=True).start()
    threading.Thread(target=accept_drain, args=(task_srv,), daemon=True).start()
    threading.Thread(target=accept_drain, args=(ls_srv,), daemon=True).start()
    bs_conn = {}
    threading.Thread(target=lambda: bs_conn.setdefault('c', bs_srv.accept()[0]), daemon=True).start()
    genv = dict(os.environ, JAVA_HOME=os.environ['SIM_BSP_JAVA_HOME'])
    gproc = subprocess.Popen([os.path.join(bsp_ext, 'lib', 'gradle-server'), f'--pipe={task_path}', f'--parentPid={os.getpid()}',
                              '--startBuildServer=true', f'--languageServerPipePath={ls_path}', f'--pipeName={bs_path}',
                              f'--bundleDir={os.path.join(bsp_ext, "server")}'], cwd=os.path.join(bsp_ext, 'lib'), env=genv,
                             stdout=open(os.environ.get('SIM_STDERR', '/dev/null') + '.gradle-server', 'w'), stderr=subprocess.STDOUT)
    bsp['gproc'] = gproc
    def importer_connect(pipe):
        # BspProxy: listen on the importer's pipe, then relay bytes both ways to the build server.
        srv = socket.socket(socket.AF_UNIX)
        try: os.unlink(pipe)
        except OSError: pass
        srv.bind(pipe); srv.listen(1); imp, _ = srv.accept()
        for _ in range(600):
            if 'c' in bs_conn: break
            time.sleep(0.1)
        bsc = bs_conn['c']; log('BSP relay connected')
        def pump(a, b):
            while True:
                d = a.recv(65536)
                if not d: break
                b.sendall(d)
        threading.Thread(target=pump, args=(imp, bsc), daemon=True).start()
        threading.Thread(target=pump, args=(bsc, imp), daemon=True).start()
    bsp['connect'] = importer_connect
p = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                     stderr=open(os.environ.get('SIM_STDERR', '/dev/null'), 'w'))
lock = threading.Lock(); pend = {}; nid = [0]
diags = {}; publishes = [0]; ready = threading.Event(); watchers = []

SYSCPU = os.environ.get('SIM_SYSCPU')  # measure whole-machine busy CPU (includes Gradle daemons/workers)
def cpu_seconds():
    if SYSCPU:
        f = open('/proc/stat').readline().split()[1:]
        v = [int(x) for x in f]
        return (v[0] + v[1] + v[2] + v[5] + v[6] + v[7]) / TICK
    try:
        f = open(f'/proc/{p.pid}/stat').read().rsplit(')', 1)[1].split()
        return (int(f[11]) + int(f[12])) / TICK
    except Exception: return 0.0
def rss_mb():
    try: return int([l for l in open(f'/proc/{p.pid}/status') if l.startswith('VmRSS')][0].split()[1]) // 1024
    except Exception: return 0
peak = [0]
def sampler():
    while p.poll() is None:
        peak[0] = max(peak[0], rss_mb()); time.sleep(1)
threading.Thread(target=sampler, daemon=True).start()

def send(m):
    b = json.dumps(m).encode()
    with lock: p.stdin.write(b'Content-Length: %d\r\n\r\n' % len(b) + b); p.stdin.flush()
def request(method, params, timeout=600):
    nid[0] += 1; k = nid[0]; e = threading.Event(); pend[k] = [e, None]
    send({'jsonrpc': '2.0', 'id': k, 'method': method, 'params': params}); e.wait(timeout); return pend.pop(k)[1] or {}
def notify(method, params): send({'jsonrpc': '2.0', 'method': method, 'params': params})
def section(name):
    cur = settings
    for part in (name or '').split('.'):
        if part: cur = cur.get(part) if isinstance(cur, dict) else None
    return cur
def reader():
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
            r = None
            if m['method'] == 'workspace/configuration': r = [section(it.get('section')) for it in m['params']['items']]
            if bsp and isinstance(m.get('params'), dict) and m['params'].get('command') == '_gradle.onWillImporterConnect':
                a_ = m['params'].get('arguments') or m['params'].get('data') or []
                pipe = a_[0] if isinstance(a_, list) else a_
                log('importer pipe (request)', m['method'], pipe); threading.Thread(target=bsp['connect'], args=(pipe,), daemon=True).start()
            if m['method'] == 'client/registerCapability':
                for reg in m['params'].get('registrations', []):
                    if reg['method'] == 'workspace/didChangeWatchedFiles': watchers.append(reg)
            send({'jsonrpc': '2.0', 'id': m['id'], 'result': r})
        elif 'id' in m:
            if m['id'] in pend: pend[m['id']][1] = m; pend[m['id']][0].set()
        elif m.get('method') == 'textDocument/publishDiagnostics':
            publishes[0] += 1; diags[m['params']['uri']] = m['params']['diagnostics']
        elif bsp and isinstance(m.get('params'), dict) and m['params'].get('command') == '_gradle.onWillImporterConnect':
            args_ = m['params'].get('data') or m['params'].get('arguments') or []
            pipe = args_[0] if isinstance(args_, list) else args_
            log('importer pipe', m.get('method'), pipe); threading.Thread(target=bsp['connect'], args=(pipe,), daemon=True).start()
        elif m.get('method') == 'language/status' and m['params'].get('type') == 'ServiceReady':
            ready.set()
threading.Thread(target=reader, daemon=True).start()

def files_with_errors():
    return sum(1 for v in diags.values() if any(d.get('severity') == 1 for d in v))
def wait_quiet(max_s=2400, window=15, threshold=float(os.environ.get('SIM_QUIET_CORES', '0.15'))):
    hist = []
    start = time.time()
    while time.time() - start < max_s and p.poll() is None:
        hist.append((time.time(), cpu_seconds()))
        hist = [x for x in hist if x[0] >= hist[-1][0] - window]
        if hist[-1][0] - hist[0][0] >= window - 2:
            rate = (hist[-1][1] - hist[0][1]) / (hist[-1][0] - hist[0][0])
            if rate < threshold: return time.time() - start - window
        time.sleep(1)
    return None
def phase(name, action):
    c0, w0, n0 = cpu_seconds(), time.time(), publishes[0]
    action()
    quiet = wait_quiet()
    r = {'label': label, 'phase': name, 'wall_s': round(time.time() - w0 - 15, 1) if quiet is not None else None,
         'cpu_s': round(cpu_seconds() - c0 - 15 * 0.0, 1), 'publishes': publishes[0] - n0,
         'files_with_errors': files_with_errors(), 'rss_mb': rss_mb(), 'peak_rss_mb': peak[0]}
    print('RESULT ' + json.dumps(r), flush=True); return r

caps = {'textDocument': {'publishDiagnostics': {}, 'synchronization': {'didSave': True}},
        'workspace': {'configuration': True, 'workspaceFolders': True, 'didChangeWatchedFiles': {'dynamicRegistration': True}},
        'window': {'workDoneProgress': True}}
def do_import():
    request('initialize', {'processId': None, 'rootUri': root.as_uri(), 'workspaceFolders': [{'uri': root.as_uri(), 'name': root.name}],
        'capabilities': caps, 'initializationOptions': {'settings': settings, 'extendedClientCapabilities': {'classFileContentsSupport': True},
        'bundles': [os.path.join(bsp_ext, 'server', 'com.microsoft.gradle.bs.importer-0.5.4.jar')] if bsp_ext else []}})
    notify('initialized', {})
    notify('workspace/didChangeConfiguration', {'settings': settings})
    ready.wait(2400); log('ServiceReady')
phase('import', do_import)

qt = root / 'engine/table/src/main/java/io/deephaven/engine/table/impl/QueryTable.java'
tb = root / 'engine/api/src/main/java/io/deephaven/engine/table/Table.java'
orig = {qt: qt.read_text(), tb: tb.read_text()}
ver = {qt: 1, tb: 1}
for f in (qt, tb):
    notify('textDocument/didOpen', {'textDocument': {'uri': f.as_uri(), 'languageId': 'java', 'version': 1, 'text': orig[f]}})
wait_quiet()
def save(f, text):
    ver[f] += 1
    notify('textDocument/didChange', {'textDocument': {'uri': f.as_uri(), 'version': ver[f]}, 'contentChanges': [{'text': text}]})
    f.write_text(text)
    notify('textDocument/didSave', {'textDocument': {'uri': f.as_uri()}})
    notify('workspace/didChangeWatchedFiles', {'changes': [{'uri': f.as_uri(), 'type': 2}]})
def body_edit():
    t = orig[qt]; i = t.index('public TrackingRowSet getRowSet() {') + len('public TrackingRowSet getRowSet() {')
    save(qt, t[:i] + '\n        int devcProbeLocal = 1;' + t[i:])
def struct_edit():
    t = orig[tb]; i = t.index('{', t.index('public interface Table')) + 1
    save(tb, t[:i] + '\n    default void devcProbeMethod() {}\n' + t[i:])
def revert():
    save(qt, orig[qt]); save(tb, orig[tb])
try:
    phase('body', body_edit)
    phase('struct', struct_edit)
    phase('revert', revert)
    if os.environ.get('SIM_GRADLE'):
        import fnmatch
        def snapshot():
            snap = {}
            for d, dirs, files in os.walk(root):
                dirs[:] = [x for x in dirs if x not in ('.git', 'node_modules', '.gradle')]
                for fn in files:
                    fp = os.path.join(d, fn); rel = os.path.relpath(fp, root)
                    if fn.endswith('.java') or '/build/license-source-set/' in '/' + rel or rel.endswith(('.gradle', '.gradle.kts')):
                        try: snap[fp] = os.stat(fp).st_mtime_ns
                        except OSError: pass
            return snap
        def gradle_phase():
            before = snapshot()
            t = orig[qt]; i = t.index('public TrackingRowSet getRowSet() {') + len('public TrackingRowSet getRowSet() {')
            save(qt, t[:i] + '\n        int devcProbeLocal2 = 2;' + t[i:])
            g0 = time.time()
            r = subprocess.run(['./gradlew', '-q', '--offline', 'compileJava'], cwd=root, capture_output=True, text=True)
            log(f'gradle compileJava exit {r.returncode} in {time.time()-g0:.0f}s')
            after = snapshot()
            changes = [{'uri': pathlib.Path(f).as_uri(), 'type': 1 if f not in before else 2} for f in after if before.get(f) != after[f]]
            changes += [{'uri': pathlib.Path(f).as_uri(), 'type': 3} for f in before if f not in after]
            log(f'{len(changes)} watched files changed by the build')
            print('RESULT ' + json.dumps({'label': label, 'phase': 'gradle_build', 'gradle_s': round(time.time()-g0), 'watched_changes': len(changes)}), flush=True)
            for k in range(0, len(changes), 1000):
                notify('workspace/didChangeWatchedFiles', {'changes': changes[k:k+1000]}); time.sleep(0.2)
        phase('after_gradle', gradle_phase)
finally:
    for f, t in orig.items(): f.write_text(t)
gc = os.environ.get('GC_LOG')
if gc and os.path.exists(gc):
    ms = [float(x) for x in re.findall(r'(\d+\.\d+)ms', open(gc).read())]
    print('RESULT ' + json.dumps({'label': label, 'phase': 'gc', 'pauses': len(ms), 'pause_total_s': round(sum(ms) / 1000, 1),
                                  'full_gcs': len(re.findall(r'Pause Full', open(gc).read()))}), flush=True)
print('RESULT ' + json.dumps({'label': label, 'phase': 'watchers', 'globs': [w.get('globPattern') if isinstance(w.get('globPattern'), str) else w for r in watchers for w in r.get('registerOptions', {}).get('watchers', [])][:40]}), flush=True)
nid[0] += 1; send({'jsonrpc': '2.0', 'id': nid[0], 'method': 'shutdown'}); time.sleep(2); send({'jsonrpc': '2.0', 'method': 'exit'}); time.sleep(3); p.kill()
if bsp: bsp['gproc'].kill()
