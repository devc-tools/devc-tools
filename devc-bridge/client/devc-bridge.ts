// Container-side client for the host command bridge.
//
//   devc-bridge <command> [args...]
//   devc-bridge version            print the client version (also --version / -V)
//
// Connects to the host bridge over TCP (a bind-mounted unix socket does not cross
// the Docker Desktop VM boundary), reads the shared token from the bind-mounted run
// dir, sends a single JSON request, prints the script's stdout/stderr, and exits
// with the script's exit code.
//
// Env:
//   DEVC_BRIDGE_ADDR        host:port of the bridge  (default host.docker.internal:48227)
//   DEVC_BRIDGE_TOKEN_FILE  path to the shared token (default /run/devc-bridge/token)

import { VERSION } from './version.ts';
import {
  BUILD_INFO_FILE,
  versionLine,
} from '../../version-info/version_info.ts';

const ADDR = Deno.env.get('DEVC_BRIDGE_ADDR') ?? 'host.docker.internal:48227';
const TOKEN_FILE = Deno.env.get('DEVC_BRIDGE_TOKEN_FILE') ??
  '/run/devc-bridge/token';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface OkResponse {
  ok: true;
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface ErrResponse {
  ok: false;
  error: string;
}
type Response = OkResponse | ErrResponse;

async function readLine(conn: Deno.Conn): Promise<string> {
  let buf = '';
  const chunk = new Uint8Array(4096);
  while (true) {
    const n = await conn.read(chunk);
    if (n === null) break;
    buf += decoder.decode(chunk.subarray(0, n), { stream: true });
    const idx = buf.indexOf('\n');
    if (idx >= 0) return buf.slice(0, idx);
  }
  return buf;
}

function parseAddr(addr: string): { hostname: string; port: number } {
  const i = addr.lastIndexOf(':');
  if (i < 0) {
    console.error(
      `devc-bridge: DEVC_BRIDGE_ADDR must be host:port, got ${
        JSON.stringify(addr)
      }`,
    );
    Deno.exit(2);
  }
  return { hostname: addr.slice(0, i), port: Number(addr.slice(i + 1)) };
}

function main(): Promise<never> {
  const [command, ...args] = Deno.args;
  if (!command) {
    console.error('usage: devc-bridge <command> [args...]');
    return Deno.exit(2);
  }
  // Answered locally, never forwarded to the host: "which client is mounted in here" is a
  // question the container must be able to answer with the bridge down, and `version` is
  // not a host command anyone could add to the allowlist to shadow it.
  if (command === 'version' || command === '--version' || command === '-V') {
    console.log(
      versionLine(
        'devc-bridge',
        VERSION,
        new URL(`./${BUILD_INFO_FILE}`, import.meta.url),
      ),
    );
    return Deno.exit(0);
  }
  return run(command, args);
}

async function run(command: string, args: string[]): Promise<never> {
  let token: string;
  try {
    token = (await Deno.readTextFile(TOKEN_FILE)).trim();
  } catch (e) {
    console.error(
      `devc-bridge: cannot read token ${TOKEN_FILE}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    console.error(
      'devc-bridge: is the host server running and the run dir bind-mounted?',
    );
    return Deno.exit(1);
  }

  const { hostname, port } = parseAddr(ADDR);
  let conn: Deno.Conn;
  try {
    conn = await Deno.connect({ hostname, port });
  } catch (e) {
    console.error(
      `devc-bridge: cannot connect to ${ADDR}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    console.error('devc-bridge: is the host server running?');
    return Deno.exit(1);
  }

  try {
    await conn.write(
      encoder.encode(JSON.stringify({ token, command, args }) + '\n'),
    );
    const line = await readLine(conn);
    let resp: Response;
    try {
      resp = JSON.parse(line) as Response;
    } catch {
      console.error(`devc-bridge: malformed response: ${line}`);
      return Deno.exit(1);
    }

    if (!resp.ok) {
      console.error(`devc-bridge: ${resp.error}`);
      return Deno.exit(1);
    }

    if (resp.stdout) await Deno.stdout.write(encoder.encode(resp.stdout));
    if (resp.stderr) await Deno.stderr.write(encoder.encode(resp.stderr));
    return Deno.exit(resp.exitCode);
  } finally {
    try {
      conn.close();
    } catch {
      // already closed
    }
  }
}

await main();
