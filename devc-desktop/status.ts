// devc-desktop's status page: what the window shows while `devc web` starts, and when it cannot
// start or has exited. Served by the app's own server, the first `Deno.serve` in the process, so
// it is on the address the desktop runtime picked (`DENO_SERVE_ADDRESS`) and the startup window
// lands on it. No token and no devc code: the page polls `/state` and can ask for a restart.

/** What the app is doing, as `/state` reports it. */
export interface Status {
  phase: 'starting' | 'failed';
  /** One line: what is happening, or why it stopped. */
  message: string;
  /** The child's last stderr lines, when it failed or exited. */
  stderr: string[];
}

/**
 * The request header a restart must carry. A custom header makes a cross-origin `fetch` send a
 * CORS preflight, which this server never answers, so another site cannot restart devc.
 */
export const RESTART_HEADER = 'x-devc-desktop';

/**
 * The status server's handler: `GET /` the page, `GET /state` the current {@link Status} as
 * JSON, `POST /restart` (with {@link RESTART_HEADER}) calls `restart`. Requests whose Host is not
 * `127.0.0.1` or `localhost` get 403, as in `devc web` (DNS rebinding).
 */
export function statusHandler(
  status: () => Status,
  restart: () => void,
): (req: Request) => Response {
  return (req) => {
    const url = new URL(req.url);
    const host = (req.headers.get('host') ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return new Response('forbidden', { status: 403 });
    }
    const headers = { 'Cache-Control': 'no-store' };
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(PAGE, {
        headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      return Response.json(status(), { headers });
    }
    if (req.method === 'POST' && url.pathname === '/restart') {
      if (req.headers.get(RESTART_HEADER) !== '1') {
        return new Response('forbidden', { status: 403 });
      }
      restart();
      return new Response(null, { status: 204, headers });
    }
    return new Response('not found', { status: 404, headers });
  };
}

// The colours are `devc web`'s own (`devc/web/static/style.css`), so the hand-over to the page
// does not flash.
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>devc web</title>
<style>
  :root { --bg: #0d0f14; --panel: #161922; --border: #2a2f3c; --text: #d7dae0;
    --muted: #8a90a0; --accent: #6aa7ff; --danger: #ff6b6b; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, sans-serif; display: grid; place-items: center;
    min-height: 100vh; }
  main { width: min(720px, calc(100vw - 32px)); }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 4px; }
  #message { color: var(--muted); margin: 0 0 16px; }
  [data-phase="failed"] #message { color: var(--danger); }
  pre { background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px; overflow: auto; max-height: 50vh; font: 12px/1.4 ui-monospace, monospace;
    white-space: pre-wrap; margin: 0 0 16px; }
  pre:empty { display: none; }
  button { background: var(--accent); color: #0d0f14; border: 0; border-radius: 6px;
    padding: 6px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  [data-phase="starting"] button { display: none; }
</style>
</head>
<body data-phase="starting">
<main>
  <h1>devc web</h1>
  <p id="message">Starting…</p>
  <pre id="stderr"></pre>
  <button id="restart" type="button">Restart devc web</button>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  async function poll() {
    try {
      const s = await (await fetch('/state')).json();
      document.body.dataset.phase = s.phase;
      $('message').textContent = s.message;
      $('stderr').textContent = s.stderr.join('\\n');
    } catch { /* the app is going away */ }
  }
  $('restart').onclick = () =>
    fetch('/restart', { method: 'POST', headers: { '${RESTART_HEADER}': '1' } })
      .then(poll);
  poll();
  setInterval(poll, 500);
</script>
</body>
</html>
`;
