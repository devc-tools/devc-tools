// A running environment's recent agent sessions, for `devc web`'s Sessions node (`list_sessions`):
// the newest Claude, Copilot and pi sessions that started in one of its project's repos, read
// from the agent homes there with one exec (`Environment.run`: in a container, a `docker exec`
// as the remote user).
//
// Everything read here is the container's, so it is untrusted: the session id must be a uuid (it
// goes on the resume command line), `cwd` an absolute path (it becomes a new shell's folder), and
// titles are only ever shown. Nothing is stored. The agent homes devc bind-mounts are shared by
// every devc container on the host, so sessions are kept only when they started under one of
// this container's repo folders.
//
// The script is POSIX `sh` with `stat`, `grep -E`, `sort`, `awk`, `sed` and `head`: GNU, BusyBox
// and macOS all have them (`stat`'s flags differ: see {@link SESSIONS_SCRIPT}'s `mt`). It never prints a whole session line (one Claude line can be megabytes),
// only `grep -o` matches of `"key":"<JSON string>"`, decoded here.

import type { Environment, RunningSession } from './environment.ts';
import { isSessionId, type SessionAgentId } from './agents.ts';
import { taskTitle } from '@devc-tools/core/tasks.ts';

/** How many sessions are listed per repo. */
export const MAX_SESSIONS = 20;

/** One listed session, as `list_sessions` answers it. */
export interface AgentSession {
  agent: SessionAgentId;
  /** The agent's session id: a uuid. */
  session: string;
  /** First line, at most 80 characters; `(untitled)` when the session has none. */
  title: string;
  /** The container folder it started in, where it has to be resumed. */
  cwd: string;
  /** The host folder of the repo whose container folder holds `cwd`. */
  root: string;
  /** Last activity, ISO: a Claude session's last `timestamp`, else the file's mtime. */
  updatedAt: string;
  /** The Herdr pane (of the server's Herdr session) a live agent process has it open in. */
  pane_id?: string;
}

export type { RunningSession };

/** A session as the script reports it, before it is matched to a repo. */
export interface RawSession {
  agent: SessionAgentId;
  session: string;
  title: string;
  cwd: string;
  /** Epoch seconds. */
  mtime: number;
}

/** A repo of the container's project: its host folder, and its container folder when mounted. */
export interface SessionRepo {
  folder: string;
  containerFolder: string | null;
}

export const UNTITLED = '(untitled)';

/** Claude's session folder names: the start folder with every non-alphanumeric made `-`. */
export function claudeDirPrefix(containerFolder: string): string {
  return containerFolder.replace(/[^A-Za-z0-9]/g, '-');
}

/** pi's: `--` + the folder without its leading `/`, slashes made `-` (a subfolder's continues). */
export function piDirPrefix(containerFolder: string): string {
  return `--${containerFolder.slice(1).replaceAll('/', '-')}`;
}

/**
 * Prints `R <session id> <HERDR_SESSION> <HERDR_PANE_ID>` per live Claude process in the
 * container, from Claude Code's per-process records (`$CLAUDE_CONFIG_DIR/sessions/<pid>.json`,
 * its own state, not a documented interface). Agent homes are shared by every devc container, so
 * a record counts only when its pid is live here and that process's start time (`/proc/<pid>/stat`
 * field 22, counted after the `)` closing the command name) is the record's `procStart`. Records
 * missing any of it are skipped. No `${…}` in it: this is a template literal.
 */
export const RUNNING_SCRIPT = String
  .raw`d=$CLAUDE_CONFIG_DIR; [ -n "$d" ] || d=$HOME/.claude
for f in "$d"/sessions/*.json; do
  [ -f "$f" ] || continue
  pid=$(basename "$f" .json)
  case $pid in ''|*[!0-9]*) continue ;; esac
  [ -r "/proc/$pid/environ" ] || continue
  st=$(sed 's/^.*) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}')
  [ -n "$st" ] || continue
  grep -q "\"procStart\":\"$st\"" "$f" || continue
  id=$(grep -oE '"sessionId":"[0-9A-Fa-f-]+"' "$f" | head -n1 | cut -d'"' -f4)
  pane=$(tr '\000' '\n' < "/proc/$pid/environ" | sed -n 's/^HERDR_PANE_ID=//p' | head -n1)
  hs=$(tr '\000' '\n' < "/proc/$pid/environ" | sed -n 's/^HERDR_SESSION=//p' | head -n1)
  [ -n "$id" ] && [ -n "$pane" ] && [ -n "$hs" ] && printf 'R %s %s %s\n' "$id" "$hs" "$pane"
done
true
`;

/**
 * {@link RUNNING_SCRIPT} for macOS, which has no `/proc`: per live record, `M <session id> <the
 * process's command line and environment>` (`ps -E`), for {@link parseRunningOutput} to take
 * the `HERDR_*` tokens from. The pid must be alive, and its start time as Claude Code writes it
 * off Linux — `LC_ALL=C TZ=UTC ps -o lstart=`, trimmed — the record's `procStart`, so a reused
 * pid's old record never counts. No `${…}` in it: this is a template literal.
 */
export const MAC_RUNNING_SCRIPT = String
  .raw`d=$CLAUDE_CONFIG_DIR; [ -n "$d" ] || d=$HOME/.claude
for f in "$d"/sessions/*.json; do
  [ -f "$f" ] || continue
  pid=$(basename "$f" .json)
  case $pid in ''|*[!0-9]*) continue ;; esac
  kill -0 "$pid" 2>/dev/null || continue
  st=$(LC_ALL=C TZ=UTC ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//; s/ *$//')
  [ -n "$st" ] || continue
  grep -qF "\"procStart\":\"$st\"" "$f" || continue
  id=$(grep -oE '"sessionId":"[0-9A-Fa-f-]+"' "$f" | head -n1 | cut -d'"' -f4)
  cmd=$(ps -E -ww -o command= -p "$pid" 2>/dev/null | head -n1)
  [ -n "$id" ] && [ -n "$cmd" ] && printf 'M %s %s\n' "$id" "$cmd"
done
true
`;

/** The running probe for any POSIX host: {@link MAC_RUNNING_SCRIPT} on macOS, else {@link RUNNING_SCRIPT}. */
export const RUNNING_PROBE = 'if [ "$(uname -s)" = Darwin ]; then\n' +
  MAC_RUNNING_SCRIPT + 'else\n' + RUNNING_SCRIPT + 'fi\n';

/**
 * Lists candidate sessions, newest first (`mt` prints `<mtime> <path>`: GNU and BusyBox `stat -c`,
 * else macOS's `stat -f`, picked once — never `stat -c … || stat -f …`, since GNU `stat` fails
 * when one glob match is missing and its `-f` is filesystem status): per agent, `$1` for each argument after it, so a busy
 * repo doesn't crowd out the others. Claude's only in the folders whose names start with the
 * arguments before `:`, `$1` each; pi's with those after it, `$1` each; Copilot's (it keeps no
 * per-folder dirs) `$1` times as many as there are folders, from all of them. Per session a line `S <agent> <mtime> <path>`, then tagged `grep -o` matches:
 * claude `C` (first cwd), `T` (last of each title key) and `L` (last `timestamp` in its last
 * 256 KiB); pi `H` (header id and cwd), `N` (last
 * session name), `U` (first user text); copilot `Y` (`workspace.yaml` lines). Then
 * {@link RUNNING_PROBE}'s `R` (or `M`) lines. No `${…}` in it: this is a template literal.
 */
export const SESSIONS_SCRIPT = String.raw`cap=$1; shift
if stat -c %Y / >/dev/null 2>&1; then mt() { stat -c '%Y %n' "$@"; }; else mt() { stat -f '%m %N' "$@"; }; fi
S='"(\\.|[^"\\])*"'
c=$CLAUDE_CONFIG_DIR; [ -n "$c" ] || c=$HOME/.claude; c=$c/projects
o=$COPILOT_HOME; [ -n "$o" ] || o=$HOME/.copilot; o=$o/session-state
p=$HOME/.pi/agent/sessions
newest() { sort -rn | uniq | head -n "$cap"; }
n=0; for a; do [ "$a" = : ] && break; n=$((n + 1)); done
for a; do [ "$a" = : ] && break; mt "$c/$a"*/*.jsonl 2>/dev/null | newest; done |
sort -rn | uniq | while read -r m f; do
  printf 'S claude %s %s\n' "$m" "$f"
  grep -m1 -oE "\"cwd\":$S" "$f" | head -n1 | sed 's/^/C /'
  grep -oE "\"(customTitle|aiTitle|lastPrompt)\":$S" "$f" |
    awk -F'"' '{l[$2]=$0} END{for(k in l) print "T " l[k]}'
  tail -c 262144 "$f" | grep -oE '"timestamp":"[0-9]{4}-[0-9]{2}-[0-9]{2}T[^"]*"' | tail -n1 | sed 's/^/L /'
done
on=; for a; do [ -n "$on" ] && mt "$p/$a"*/*.jsonl 2>/dev/null | newest; [ "$a" = : ] && on=1; done |
sort -rn | uniq | while read -r m f; do
  printf 'S pi %s %s\n' "$m" "$f"
  head -n1 "$f" | grep -oE "\"(id|cwd)\":$S" | sed 's/^/H /'
  grep -F '"type":"session_info"' "$f" | grep -oE "\"name\":$S" | tail -n1 | sed 's/^/N /'
  grep -m1 -F '"role":"user"' "$f" | grep -oE "\"text\":$S" | head -n1 | sed 's/^/U /'
done
mt "$o"/*/workspace.yaml "$o"/*/events.jsonl 2>/dev/null | sort -rn |
awk '{d=$0; sub(/^[0-9]+ /,"",d); sub(/\/[^\/]*$/,"",d); if(!s[d]++) print $1, d}' |
head -n "$((cap * n))" | while read -r m d; do
  [ -f "$d/workspace.yaml" ] || continue
  printf 'S copilot %s %s\n' "$m" "$d"
  grep -E '^(id|cwd|name|summary):' "$d/workspace.yaml" | sed 's/^/Y /'
done
` + RUNNING_PROBE;

/**
 * The `sh -c` argv after the script: the candidate cap per folder, Claude's folder prefixes, `:`,
 * pi's. `:`
 * is never a prefix (pi's start with `--`, Claude's are alphanumerics and `-`).
 */
export function sessionsArgs(containerFolders: readonly string[]): string[] {
  const folders = [...new Set(containerFolders)].filter((f) =>
    f.startsWith('/') && f !== '/'
  );
  return [
    String(2 * MAX_SESSIONS),
    ...folders.map(claudeDirPrefix),
    ':',
    ...folders.map(piDirPrefix),
  ];
}

/** `"key":"…"` (a `grep -o` match) as `[key, value]`, or null. */
function jsonPair(match: string): [string, string] | null {
  try {
    const o = JSON.parse(`{${match}}`) as Record<string, unknown>;
    const [entry] = Object.entries(o);
    return entry && typeof entry[1] === 'string' ? [entry[0], entry[1]] : null;
  } catch {
    return null;
  }
}

/** A YAML scalar as Copilot writes one: plain, `"double"` (JSON-like) or `'single'` quoted. */
function yamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try {
      const s = JSON.parse(v);
      return typeof s === 'string' ? s : v;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replaceAll("''", "'");
  }
  return v;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

interface Block {
  agent: SessionAgentId;
  mtime: number;
  path: string;
  lines: [string, string][];
}

function rawSession(b: Block): RawSession | null {
  const pairs = (tag: string) =>
    b.lines.filter(([t]) => t === tag).map(([, v]) => jsonPair(v)).filter((
      p,
    ): p is [string, string] => p !== null);
  let session = '';
  let cwd = '';
  let title = '';
  let mtime = b.mtime;
  if (b.agent === 'claude') {
    session = baseName(b.path).replace(/\.jsonl$/, '');
    cwd = pairs('C').find(([k]) => k === 'cwd')?.[1] ?? '';
    const titles = new Map(pairs('T'));
    title = [
      titles.get('customTitle'),
      titles.get('aiTitle'),
      titles.get('lastPrompt'),
    ].map((t) => taskTitle(t ?? '')).find((t) => t !== '') ?? '';
    // Claude appends untimed lines (`away_summary`, `mode`) to old sessions, touching the file:
    // its last timestamped line is when the session was last at work.
    const last = Date.parse(pairs('L').at(-1)?.[1] ?? '');
    if (Number.isFinite(last)) mtime = Math.floor(last / 1000);
  } else if (b.agent === 'pi') {
    const header = new Map(pairs('H'));
    session = header.get('id') ?? '';
    cwd = header.get('cwd') ?? '';
    title = [pairs('N')[0]?.[1], pairs('U')[0]?.[1]]
      .map((t) => taskTitle(t ?? '')).find((t) => t !== '') ?? '';
  } else {
    session = baseName(b.path);
    const yaml = new Map<string, string>();
    for (const [, line] of b.lines.filter(([t]) => t === 'Y')) {
      const i = line.indexOf(':');
      if (i > 0 && !yaml.has(line.slice(0, i))) {
        yaml.set(line.slice(0, i), yamlScalar(line.slice(i + 1)));
      }
    }
    cwd = yaml.get('cwd') ?? '';
    title = [yaml.get('name'), yaml.get('summary')]
      .map((t) => taskTitle(t ?? '')).find((t) => t !== '') ?? '';
  }
  if (!isSessionId(session)) return null;
  if (!cwd.startsWith('/') || /[\n\0]/.test(cwd)) return null;
  return {
    agent: b.agent,
    session,
    title: title || UNTITLED,
    cwd,
    mtime,
  };
}

/** {@link SESSIONS_SCRIPT}'s output as sessions. Drops anything malformed; never throws. */
export function parseSessionsOutput(out: string): RawSession[] {
  const blocks: Block[] = [];
  for (const line of out.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    const rest = line.slice(sp + 1);
    if (tag === 'R' || tag === 'M') continue;
    if (tag === 'S') {
      const m = /^(claude|copilot|pi) (\d+) (\/.*)$/.exec(rest);
      blocks.push(
        m
          ? {
            agent: m[1] as SessionAgentId,
            mtime: Number(m[2]),
            path: m[3],
            lines: [],
          }
          // A malformed head: its lines are dropped with it.
          : { agent: 'claude', mtime: NaN, path: '', lines: [] },
      );
      continue;
    }
    blocks.at(-1)?.lines.push([tag, rest]);
  }
  return blocks.filter((b) => Number.isFinite(b.mtime) && b.path !== '')
    .map(rawSession)
    .filter((s): s is RawSession => s !== null);
}

/**
 * The value of the last `NAME=…` token of a `ps -E` line (the environment follows the command,
 * so its own arguments can't stand in for it), or null.
 */
function envToken(line: string, name: string): string | null {
  let value: string | null = null;
  for (const token of line.split(/\s+/)) {
    if (token.startsWith(`${name}=`)) value = token.slice(name.length + 1);
  }
  return value === '' ? null : value;
}

/**
 * {@link RUNNING_SCRIPT}'s `R` lines and {@link MAC_RUNNING_SCRIPT}'s `M` lines (in any output) as
 * running sessions; drops malformed ones.
 */
export function parseRunningOutput(out: string): RunningSession[] {
  const running: RunningSession[] = [];
  const add = (
    session: string,
    herdrSession: string | null,
    pane: string | null,
  ) => {
    if (
      isSessionId(session) && herdrSession !== null &&
      /^\S+$/.test(herdrSession) &&
      pane !== null && /^[\w:.-]+$/.test(pane)
    ) running.push({ session, herdrSession, paneId: pane });
  };
  for (const line of out.split('\n')) {
    const r = /^R (\S+) (\S+) (\S+)$/.exec(line);
    if (r) {
      add(r[1], r[2], r[3]);
      continue;
    }
    const m = /^M (\S+) (.*)$/.exec(line);
    if (m) {
      add(
        m[1],
        envToken(m[2], 'HERDR_SESSION'),
        envToken(m[2], 'HERDR_PANE_ID'),
      );
    }
  }
  return running;
}

/**
 * `sessions` with `pane_id` on each Claude session a process runs in a pane of Herdr session
 * `herdrSession` (the first such pane when several do).
 */
export function markRunning(
  sessions: readonly AgentSession[],
  running: readonly RunningSession[],
  herdrSession: string,
): AgentSession[] {
  const panes = new Map<string, string>();
  for (const r of running) {
    if (r.herdrSession === herdrSession && !panes.has(r.session)) {
      panes.set(r.session, r.paneId);
    }
  }
  return sessions.map((s) => {
    const pane_id = s.agent === 'claude' ? panes.get(s.session) : undefined;
    return pane_id === undefined ? s : { ...s, pane_id };
  });
}

/**
 * The sessions that started in one of `repos`' container folders (the deepest one wins), newest
 * first, one per agent and id, at most `max` per repo.
 */
export function pickSessions(
  raw: readonly RawSession[],
  repos: readonly SessionRepo[],
  max = MAX_SESSIONS,
): AgentSession[] {
  const mounted = repos.filter((r): r is SessionRepo & {
    containerFolder: string;
  } => r.containerFolder !== null)
    .sort((a, b) => b.containerFolder.length - a.containerFolder.length);
  const seen = new Set<string>();
  const perRepo = new Map<string, number>();
  const out: AgentSession[] = [];
  const sorted = [...raw].sort((a, b) =>
    b.mtime - a.mtime || a.session.localeCompare(b.session)
  );
  for (const s of sorted) {
    const repo = mounted.find((r) =>
      s.cwd === r.containerFolder ||
      s.cwd.startsWith(
        r.containerFolder.endsWith('/')
          ? r.containerFolder
          : `${r.containerFolder}/`,
      )
    );
    const key = `${s.agent}\n${s.session}`;
    if (!repo || seen.has(key)) continue;
    seen.add(key);
    const n = perRepo.get(repo.folder) ?? 0;
    if (n >= max) continue;
    perRepo.set(repo.folder, n + 1);
    out.push({
      agent: s.agent,
      session: s.session,
      title: s.title,
      cwd: s.cwd,
      root: repo.folder,
      updatedAt: new Date(s.mtime * 1000).toISOString(),
    });
  }
  return out;
}

/**
 * The environment's recent sessions in `repos`, each Claude one a process runs in a pane of
 * Herdr session `herdrSession` with its `pane_id`. Throws on a failed exec (the command's stderr
 * in the message).
 */
export async function listAgentSessions(
  env: Pick<Environment, 'run'>,
  repos: readonly SessionRepo[],
  herdrSession: string,
): Promise<AgentSession[]> {
  const folders = repos.flatMap((r) =>
    r.containerFolder === null ? [] : [r.containerFolder]
  );
  if (folders.length === 0) return [];
  const out = await env.run({
    cwd: '/',
    cmd: ['sh', '-c', SESSIONS_SCRIPT, 'sh', ...sessionsArgs(folders)],
  });
  if (out.code !== 0) {
    throw new Error(
      out.stderr.trim() || `listing sessions failed (exit ${out.code})`,
    );
  }
  const text = new TextDecoder().decode(out.stdout);
  return markRunning(
    pickSessions(parseSessionsOutput(text), repos),
    parseRunningOutput(text),
    herdrSession,
  );
}

/** The Herdr pane of `herdrSession` a live Claude process runs `session` in, if any; never throws. */
export async function runningPane(
  env: Pick<Environment, 'runningAgents'>,
  session: string,
  herdrSession: string,
): Promise<string | null> {
  try {
    return (await env.runningAgents()).find((r) =>
      r.session === session && r.herdrSession === herdrSession
    )?.paneId ?? null;
  } catch {
    return null;
  }
}
