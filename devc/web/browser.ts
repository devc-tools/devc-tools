// `devc web` opening the page in the default browser. The opener's argv is visible to `ps`, so
// it never carries the token: the server answers a one-time `/open/<nonce>` link instead (see
// `openRedirect`), whose first use redirects to the token URL and whose every later use fails.

/** The path of the one-time link for `nonce`. */
export function openPath(nonce: string): string {
  return `/open/${nonce}`;
}

/**
 * A server's one-time link: `answer(pathname)` is the response for a request to
 * {@link openPath}`(nonce)` — a redirect to the page with `token` the first time, a 404 after —
 * and `null` for any other path. With no `nonce`, every path is `null`.
 */
export function openRedirect(nonce: string | undefined, token: string) {
  let used = nonce === undefined;
  return (pathname: string): Response | null => {
    if (!pathname.startsWith('/open/')) return null;
    if (used || pathname !== openPath(nonce!)) {
      return new Response('this link has already been used', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    used = true;
    return new Response(null, {
      status: 303,
      headers: { Location: `/#token=${token}`, 'Cache-Control': 'no-store' },
    });
  };
}

/**
 * The command that opens `url` in the default browser on `os`, or null where there is none to
 * try: Linux with no display (a server, an SSH session, a container).
 */
export function openCommand(
  os: typeof Deno.build.os,
  url: string,
  env: (k: string) => string | undefined,
): string[] | null {
  if (os === 'darwin') return ['open', url];
  if (os === 'windows') return ['cmd', '/c', 'start', '', url];
  if (!env('DISPLAY') && !env('WAYLAND_DISPLAY')) return null;
  return ['xdg-open', url];
}

/** Opens `url` in the default browser, if there is one to try. Never throws or waits. */
export function openBrowser(url: string): void {
  const cmd = openCommand(Deno.build.os, url, (k) => Deno.env.get(k));
  if (cmd === null) return;
  try {
    const proc = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn();
    proc.status.catch(() => {});
    proc.unref();
  } catch { /* no opener: the printed URL still works */ }
}
