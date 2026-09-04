# keepawake-ping-telemetry

Record every keepawake ping the host bridge receives, and report the distribution of
**gaps between pings**, so the idle timeout can be set from measurement instead of
judgement.

## Why

`DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` defaults to 300 000. The README's stated justification
is that a hook ping cannot cover a single long tool call, so the timeout "must exceed
the longest plausible gap between pings." Nobody has ever measured that gap.

Two things now make the number worth revisiting rather than inheriting:

- **A second client exists with a completely different cadence.**
  `herdr-plugins`' `bridge-keepawake` pings every 2 s for as long as any Herdr pane
  reports a working agent — including throughout a long `Bash` call, which is exactly
  the window where hooks go silent. For sessions it watches, the original
  justification for 300 s does not apply.
- **The setting is global.** `Keepawake` holds one timer, re-armed per ping
  (`host/keepawake.ts` — `clearTimeout` then `setTimeout(#idleMs)`), so one value has
  to satisfy the least frequent client. Today that is the hooks, and 300 s is a
  compromise that does not even cover the documented worst case: Claude Code caps
  `Bash` at 10 minutes.

The precedent for how to settle this is `herdr-plugins`' `caffeinate-grace-tuning`:
run 1 produced nothing usable because the interesting lines were logged below the
active level; adding a purpose-built report made run 2 conclusive and set
`idleGraceSec = 60` on a measured 22.1 s ceiling. This plan is the same move for the
host timeout — **instrument first, decide second.**

Explicitly out of scope: changing the default, and the per-ping lease model sketched
under [Follow-on](#follow-on). Neither should be attempted before the data exists.

## What gets measured

The deliverable is the answer to four questions:

1. What is the real distribution of inter-ping gaps, per client family?
2. How long is the longest gap while work is genuinely in flight — the number the
   timeout must exceed?
3. How much of the gap is long tool calls versus model think-time between them?
4. Does the timer ever actually expire mid-session, and after which label?

## Step 1 — the ping log

`host/core.ts` intercepts `ping` at line ~215, already extracting `args[0]` as the
event label. Record there, and record expiry inside `Keepawake`.

**Enablement.** Opt-in, via a new env var read once at launch alongside the existing
keepawake config in `host/config.ts`:

| Env var | Default | Meaning |
| --- | --- | --- |
| `DEVC_BRIDGE_PING_LOG` | unset | Absolute path to the JSONL log. **Unset disables logging entirely** — no file is created and the ping path is unchanged. |

Unset-means-off is deliberate: this is diagnostic instrumentation, not a feature, and
a bridge that silently starts writing an unbounded file on every user's machine is
not acceptable. Config is read once at launch, so enabling it means
`devc-bridge restart`, not `start` — the same rule the other keepawake vars document.

**Record format.** One JSON object per line, written append-only. Exact fields:

```json
{"t":"2026-09-04T22:06:09.281Z","type":"ping","label":"bridge-keepawake:1","gapMs":2004,"armedBefore":true,"remainingMsBefore":297996}
{"t":"2026-09-04T22:11:09.281Z","type":"expire","label":null,"gapMs":null,"armedBefore":true,"remainingMsBefore":0}
{"t":"2026-09-04T21:00:00.000Z","type":"start","label":null,"gapMs":null,"armedBefore":false,"remainingMsBefore":0,"idleMs":300000}
```

| Field | Type | Definition |
| --- | --- | --- |
| `t` | string | `new Date().toISOString()` — UTC, millisecond precision |
| `type` | string | `"ping"`, `"expire"`, or `"start"` (one `start` per bridge launch) |
| `label` | string \| null | `args[0]` as passed by the client; `null` when the client sent none |
| `gapMs` | number \| null | ms since the previous `ping` record **of any label**; `null` for the first ping after a `start` |
| `armedBefore` | boolean | whether the keepalive was already armed when this ping arrived |
| `remainingMsBefore` | number | ms left on the timer at ping time; `0` when not armed |
| `idleMs` | number | **`start` records only** — the configured timeout, so a log is self-describing |

`gapMs` computed host-side is the whole point: it is the quantity the timeout has to
exceed, and computing it at write time avoids any clock-skew or ordering question in
the analysis.

**Rotation.** Before each write, if the file exceeds **8 MB**, rename it to
`<path>.1` (replacing any existing `.1`) and start a new file. One generation only.
At ~110 bytes per record and a 2 s plugin cadence, 8 MB is roughly two weeks of
8-hour days — enough for the study, bounded for safety.

**Failure discipline.** A logging failure must never affect a ping. Wrap the write so
any error is swallowed after one `log()` line, exactly as `Keepawake#enqueue` already
treats a failing command. The ping response is `pong` regardless.

## Step 2 — the report

`host/tools/ping-report.ts`, run with `deno run --allow-read`. Mirrors
`agent-caffeinate/tools/gap-report.py` in intent.

```
devc-bridge ping-report [--log <path>] [--since <ISO8601>] [--json]
```

Reachable as a `deno task report` in `host/deno.json`; it is a developer tool and is
deliberately **not** added to the shipped `devc-bridge` CLI or the command allowlist.

Default (human) output groups by **label family** — the label up to the first `:`, so
every `bridge-keepawake:N` collapses into one family while `PreToolUse` and
`PostToolUse` stay distinct:

```
ping-report  /Users/…/state/ping-log.jsonl
  window        : 2026-09-04T21:00:00Z → 2026-09-11T18:22:10Z (6d 21h)
  bridge launches: 4       expiries: 11       idleMs: 300000

  family              pings    p50      p90      p99      max
  bridge-keepawake    41203    2.0s     2.1s     2.4s     6.1s
  PreToolUse           1877    4.2s    31.0s    92.5s   241.0s
  PostToolUse          1877    3.9s    28.7s    88.1s   239.5s
  UserPromptSubmit      214   61.0s   402.0s   901.0s  1804.0s

  overall max gap     : 241.0s  (between PostToolUse and PreToolUse)
  max gap before expiry: 300.0s (11 expiries)
```

`--json` emits the same numbers as a single object and is the stable contract:
`{window, launches, expiries, idleMs, families: {<family>: {pings, p50Ms, p90Ms,
p99Ms, maxMs}}, overallMaxGapMs, expiryCount}`. Percentiles use nearest-rank on the
sorted gap list.

**Interpreting it.** The number the timeout must exceed is the **max gap excluding
gaps that end a session** — a long gap followed by nothing is you stopping work, not a
cushion failure. The report separates these by only counting a gap when a later ping
closes it; a trailing gap is reported as `expiries`, not as a max.

## Step 3 — run it

1. `DEVC_BRIDGE_PING_LOG=~/.config/devc-bridge/state/ping-log.jsonl devc-bridge restart`
2. Work normally for **at least five working days**, including at least one long build
   in a session Herdr is *not* watching — that is the case the 300 s exists for, and a
   log without it cannot justify keeping or lowering the value.
3. `deno task report` and record the outcome in `## Findings`.

The comparison that matters: per-family max gap against the current 300 000 ms. If
the hooks' max gap is well under it, the default is larger than it needs to be even
for hooks-only sessions. If `bridge-keepawake`'s max gap stays near 2 s as expected,
that independently confirms a short cushion is safe wherever the plugin is watching.

## Follow-on

**Do not build this yet.** Recorded so the telemetry is designed with it in mind.

Per-ping cushions would let each client declare its own requirement instead of one
global compromise: `bridge-keepawake` asks for ~60 s (it pings every 2 s), hooks ask
for more when they are the only pinger. Two design points already settled:

- **Deadlines, not timer resets.** A per-ping TTL layered on the current
  `clearTimeout`/`setTimeout` model lets a frequent short-cushion client *shorten*
  what a coarse client asked for. The correct model is
  `deadline = max(deadline, now + clamp(ttl))` — a ping only ever extends.
- **Leases, for `PreToolUse`/`PostToolUse` bracketing.** Because those hooks bracket a
  tool call, `PostToolUse` can hand back a long cushion the moment it is no longer
  needed. Shortening is only safe if a caller can move *its own* entry and no one
  else's, so leases must be keyed — `session_id` from the hook JSON is the natural
  key and is already parsed by the seed's other hooks. `PostToolUse` should
  **downgrade, not release**, or protection drops to zero between tool calls.
- **Clamp server-side.** The token controls who may ping, but any process in the
  container can. An unbounded requested TTL is an unbounded keepawake.

The open question the telemetry answers first: what a `PostToolUse` downgrade should
downgrade *to*. That value is set by model think-time between tool calls, which is
one of the gaps this log measures.

## Checklist

- [ ] 1. `DEVC_BRIDGE_PING_LOG` parsed in `host/config.ts`, unset = disabled
- [ ] 2. `ping` and `expire` records written from `host/core.ts` / `host/keepawake.ts`,
      with `gapMs` computed at write time
- [ ] 3. One `start` record per launch, carrying `idleMs`
- [ ] 4. 8 MB rotation to `<path>.1`, one generation
- [ ] 5. Logging failures swallowed after one `log()` line; ping response unaffected
- [ ] 6. `host/tools/ping-report.ts` + `deno task report`, human and `--json` output
- [ ] 7. README: the env var, the record format, and that it is opt-in diagnostics
- [ ] 8. `docs/testing.md`: how to enable and what to collect
- [ ] 9. Five-day run recorded in `## Findings`

## Validation

- [ ] `cd devc-bridge/host && deno task check` — clean
- [ ] `cd devc-bridge/host && deno task test` — existing tests still pass
- [ ] New test: with `DEVC_BRIDGE_PING_LOG` unset, a ping creates **no** file anywhere
      under the state dir and the response is still `pong`
- [ ] New test: with it set, three pings 50 ms apart produce three `ping` lines whose
      `gapMs` values are `null`, ~50, ~50
- [ ] New test: a log already larger than 8 MB is rotated to `.1` on the next write,
      and a pre-existing `.1` is replaced
- [ ] New test: a write failure (path pointing at an unwritable directory) still
      returns `pong` and does not throw
- [ ] `deno run --allow-read tools/ping-report.ts --log <fixture> --json` on a
      committed fixture emits the documented object with expected percentiles
- [ ] Manual: `devc-bridge ping test` from inside a container appends one line with
      `label: "test"`
- [ ] Manual: after `DEVC_BRIDGE_KEEPAWAKE_IDLE_MS=10000 devc-bridge restart`, one
      ping then 15 s of silence writes exactly one `expire` record

## Relevant Files

- `devc-bridge/host/config.ts` — parse `DEVC_BRIDGE_PING_LOG`
- `devc-bridge/host/core.ts` — ping interception (~line 215) is where a `ping` record
  is written
- `devc-bridge/host/keepawake.ts` — `#expire()` writes the `expire` record; `status()`
  unchanged
- `devc-bridge/host/deno.json` — add `tools/ping-report.ts` to the `check` task, add a
  `report` task
- `devc-bridge/host/tools/ping-report.ts` — new
- `devc-bridge/host/tests/ping_log_test.ts` — new
- `devc-bridge/host/tests/fixtures/ping-log-sample.jsonl` — new, for the report test
- `devc-bridge/README.md` — env var table (~line 344), keepawake semantics notes
  (~line 355–405)
- `devc-bridge/docs/testing.md` — how to enable and what to collect
- `.plans/PLAN.md` — status entry and phase row

## Findings

_To be filled in after the five-day run. Record the per-family gap table, the overall
max gap, the expiry count, and an explicit recommendation on
`DEVC_BRIDGE_KEEPAWAKE_IDLE_MS` — including "leave it at 300 000" if that is what the
data says._
