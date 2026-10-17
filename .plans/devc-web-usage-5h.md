# devc-web-usage-5h

- [ ] `usageItems` (`devc/web/static/lib/host_status.js`): the strip shows one window per source, `33%/3h10m`; the tooltip has one row per window, `5h 33%/3h10m`
- [ ] Tests in `devc/tests/web_host_status_test.ts` rewritten for the new text and title
- [ ] `devc/README.md`'s host status strip paragraph and `usageItems`' doc comment updated
- [ ] Verify (below) and ask the user to try it in their open tab

The usage item in the host status strip (bottom left of the sidebar) packs every window into one
item. The text is all the percentages (`77/11%`) and the tooltip is the time to each reset in the
same order (`1h5m/3d4h`), so you have to line the two up to read either. Instead:

- **Strip:** the 5-hour window only, as used percentage / time to reset: `33%/3h10m`.
- **Tooltip:** every window on its own row, each with its label, used percentage and time to
  reset:

  ```
  5h 33%/3h10m
  7d 18%/6d4h
  ```

  Native `title` tooltips show `\n` as a line break (the pane rows already rely on this), so
  rows are used rather than bullets.

Page only: no server, protocol, tap or usage file change, so `devc web --live` picks it up.

## Concept boundaries

- **Window id vs label.** The tap writes `id` (`five_hour`, `seven_day`, `seven_day_opus`) and a
  short `label` (`5h`, `7d`, `7d opus`). Before this plan, `usageItems` never looked at a
  window's id or label to decide anything. Now it has to pick the strip's window, and it picks by
  **label** (`5h`, the same thing the tooltip shows), with a fallback so a source with no `5h`
  window (another agent's `1mo`, say) still shows something.
- **Time to reset vs time remaining in the window.** "Remaining time" here means time until
  `resetsAt`, which is what `formatIn(resetsAt - now)` already gives. It isn't recomputed from
  the window's length.
- **Strip state vs strip text.** The text shows one window, but `high` still looks at **every**
  window, so a 7d window at 95% still turns the item red. The tooltip says which window it is.

## Existing touchpoints

| File                                 | Role                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `devc/web/static/lib/host_status.js` | `usageItems` (rewritten), `formatIn` (reused as is), `USAGE_STALE_S`, `USAGE_HIGH_PERCENT`.                                  |
| `devc/web/static/app.js`             | `renderHostStatus`: inserts `text` and `title` as text. Unchanged; the one-minute re-render already keeps the times current. |
| `devc/tests/web_host_status_test.ts` | The three `usageItems` tests (exact `text` / `title` strings), rewritten.                                                    |
| `devc/README.md` (around line 333)   | Describes the strip as `77/11%` with a `1h5m/3d4h` tooltip.                                                                  |

## Contracts

`usageItems(sources, now)` keeps its signature and item shape
(`{key, state, text, title}`, one item per source with at least one window, `key` `usage:<agent>`).

**The strip window** of a source: its first window whose `label` is exactly `5h`, else its first
window.

**`text`:** `<prefix><cell(strip window)>`, where `prefix` is `<agent>` when there is more than
one source (as today) and

| Window                       | `cell`        | Example     |
| ---------------------------- | ------------- | ----------- |
| `resetsAt` passed (`<= now`) | `—`           | `—`         |
| `resetsAt` `null`            | `<pct>%/?`    | `33%/?`     |
| otherwise                    | `<pct>%/<in>` | `33%/3h10m` |

`pct` is `Math.round(usedPercentage)`, and `in` is `formatIn(resetsAt - now)`.

**`title`:** one line per window, in the source's order, joined with `\n`:
`<label> <cell(window)>`, e.g. `5h 33%/3h10m`, `7d —`, `7d opus 4%/?`. With more than one
source, the agent's name is the first line.

**`state`**, first match wins:

1. `high`: any window not yet reset has `pct >= USAGE_HIGH_PERCENT`.
2. `reset`: the strip window's reset has passed.
3. `stale`: `now - observedAt > USAGE_STALE_S`.
4. `usage`.

The CSS for these states is unchanged.

Tests to cover: a 5h window found when it isn't first; a source without a `5h` window showing
its first window; passed and `null` resets in both text and title; a `high` 7d window behind a
low 5h one; `stale`; two sources (prefix, agent line in the title); and no item for an empty
source or an empty list.

## Verify

```bash
cd /workspaces/tools/devc-tools/devc
deno task check && deno task test
cd .. && deno fmt --check
```

In headless Chromium against the checkout's page with a fake WebSocket sending a `usage` like the
user's file (`5h` 33% resetting in about 3h, `7d` 18% in about 6d), check that:

- the strip reads `33%/3h10m` (or whatever the fake times give);
- the item's `title` has two lines;
- moving the fake clock past the 5h reset turns the strip into `—` with state `reset`, while
  the 7d row stays in the tooltip.

Then ask the user, in their open tab:

1. The strip shows only the 5h window, as percentage / time to reset.
2. Hovering shows one row per window.
3. The time ticks down within a minute or two.
