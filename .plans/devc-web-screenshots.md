# devc-web-screenshots — give an agent a screenshot from devc web

The person gives an agent running in a devc web terminal an image: pasted (Ctrl/Cmd+V) or dropped
onto the terminal. devc web writes the image into the pane's environment (the container, or this machine
for a host project) and pastes its path into the terminal. Agent TUIs (Claude Code, Codex)
attach a pasted image path as an image; any other program just sees a path it can read.

This is what a native terminal's image paste does for Claude Code, which cannot work here:
the agent runs in a container (or behind Herdr) with no access to the browser's clipboard.

Taking the screenshot is left to the OS: macOS Cmd+Ctrl+Shift+4 and Windows Win+Shift+S copy
it to the clipboard, and Linux desktops' screenshot tools can too. So paste covers screenshots in
both the browser and devc-desktop. An in-page **Capture** (the browser's screen-share picker) is
not in this plan: devc-desktop's views have no display-media handler, so it would not work there.

Agent-initiated screenshots (an agent asking for a PNG of the page or a tile) are out of scope.

## Checklist

- [ ] Step 0 (manual, before writing code): in a devc web pane running Claude Code, paste
      `ESC[200~` + an absolute PNG path + `ESC[201~` (a single-line paste from the page is sent
      without markers today, so do this with a temporary console call to `send({type: 'input',
      …})`). Confirm it shows `[Image #1]`. If it does not, stop and report to the user: the
      insertion contract below needs revisiting.
- [x] `devc/web/images.ts` (new): type sniffing, file naming, the folder, pruning (see Contracts)
- [x] `devc/web/environment.ts`: `EnvFiles.writeImage(dir, file, bytes)`
- [x] `devc/web/container_files.ts`: the exec-backed `writeImage` (private folder and file, prune)
- [x] `devc/web/env_host.ts`: `hostFiles().writeImage` (same contract through Deno FS)
- [x] `devc/web/protocol.ts`: `attach_image` message, its parser and `MAX_IMAGE_MESSAGE`
- [x] `devc/web/server.ts`: the `attach_image` handler
- [x] `devc/web/static/lib/input.js`: `pastePaths(paths)`
- [x] `devc/web/static/tiles.js`: image paste and drop on pane tiles; the upload and the
      path insertion
- [x] `devc/web/static/style.css`: the drop-target highlight on a pane tile
- [x] `devc/deno.json`: `web/images.ts` in the `check` task
- [x] `devc/README.md`: the devc web **Input** bullet
- [x] Tests listed under Relevant Files

## Contracts

### Protocol (`devc/web/protocol.ts`)

New client message, answered like `write_file` (`{id, ok: true, result}` or a failure):

```ts
| {
    type: 'attach_image';
    id: string;
    container: string;          // the pane's environment id, as `input` names it
    source: 'paste' | 'drop';
    mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;               // base64 (standard alphabet, padded) of the image's bytes
  }
```

- Result: `{ path: string; size: number }` — `path` absolute in the environment, `size` in bytes.
- `MAX_IMAGE_BYTES = 20 * 1024 * 1024` (decoded) is exported from `images.ts`.
  `MAX_IMAGE_MESSAGE = 28 * 1024 * 1024` (raw JSON length) is checked in `parseClientMessage`
  for `attach_image` before parsing fields, as `lsp_send` is checked against `MAX_LSP_MESSAGE`:
  over it → `bad_request` `message too large`.
- `source` and `mime` are checked with `oneOf`; anything else → `bad_request`.
- Allowed under `--live` and `--live-yolo`: like `write_file`, it writes only inside the
  environment, as its user.

### Server (`devc/web/server.ts`)

- No session for `container` → `fail(…, 'not_running', 'the container is not running')`, in the
  same branch as `write_file`.
- Decode `data` with `decodeBase64` from `jsr:@std/encoding/base64`. Invalid base64 →
  `bad_request` `not valid base64`. Over `MAX_IMAGE_BYTES` → `too_large`
  `images up to 20 MB can be attached`.
- Sniff the bytes (below). Unrecognized, or not the type `mime` names → `bad_request`
  `not a PNG, JPEG, GIF or WebP image`.
- `home = await session.env.home()`. `null` → `write_failed`
  `the environment has no home folder to put the image in`.
- Folder: `<home>/.cache/devc/images`. File: `imageFileName(source, now, ext)` (below).
- `session.env.files.writeImage(dir, file, bytes)`; reply `{ path: file, size: bytes.length }`.
  A `FilesError` fails with its code, anything else with `write_failed`.

### `devc/web/images.ts`

- **Sniffing** (`imageType(bytes)` → `'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' |
  null`):
  - PNG: first 8 bytes `89 50 4E 47 0D 0A 1A 0A`
  - JPEG: first 3 bytes `FF D8 FF`
  - GIF: first 6 bytes ASCII `GIF87a` or `GIF89a`
  - WebP: bytes 0–3 ASCII `RIFF` and bytes 8–11 ASCII `WEBP`
- **Extension**: png → `png`, jpeg → `jpg`, gif → `gif`, webp → `webp`.
- **File name**: `<source>-<YYYYMMDD>-<HHMMSS>-<hex6>.<ext>`, e.g.
  `paste-20261029-150405-a1b2c3.png`. Date and time are the server's **local** time, each field
  zero-padded (`getFullYear`, `getMonth() + 1`, `getDate`, `getHours`, `getMinutes`,
  `getSeconds`). `hex6` is 3 bytes from `crypto.getRandomValues`, lowercase hex.
- **Name pattern** for pruning: `/^(paste|drop)-\d{8}-\d{6}-[0-9a-f]{6}\.(png|jpg|gif|webp)$/`.
  Only matching files are ever removed.
- `IMAGE_TTL_DAYS = 7`.

### `EnvFiles.writeImage(dir, file, bytes)`

Writes `bytes` to `file` (absolute, inside `dir`), then prunes `dir`. Contract for both
implementations:

- `dir` is created with its missing parents; `dir` itself is mode `0700`, `file` is `0600`
  (screenshots can hold anything on the person's screen).
- The file is new (its name is random); it is not written in place.
- After a successful write, every file directly in `dir` matching the name pattern whose mtime is
  more than `IMAGE_TTL_DAYS` days old is removed. Pruning errors are ignored.
- A write error: `forbidden` for permission denied / read-only file system; `not_running` for a
  stopped container (same stderr matching as `writeContainerText`); otherwise an `Error` with the
  command's stderr.

Container (`container_files.ts`), one `env.run({interactive: true, cwd: '/', cmd})` with `bytes`
on stdin. `dir` and `file` ride in as `$1`/`$2`, never spliced:

```sh
umask 077 && mkdir -p "$1" && chmod 700 "$1" && cat > "$2" &&
{ find "$1" -maxdepth 1 -type f -mtime +7 \
    \( -name 'paste-*' -o -name 'drop-*' \) -delete 2>/dev/null; true; }
```

(The `find` globs are looser than the regex; the folder holds only devc's images, so that is
enough. BusyBox `find` supports `-maxdepth`, `-mtime` and `-delete`.)

Host (`env_host.ts`): `Deno.mkdir(dir, {recursive: true, mode: 0o700})`, then
`Deno.chmod(dir, 0o700)` (skipped on Windows), `Deno.writeFile(file, bytes, {mode: 0o600,
createNew: true})`, then `Deno.readDir` + `Deno.stat` and `Deno.remove` for pattern-matching files
older than the TTL.

### Inserting the path (`devc/web/static/lib/input.js`)

`pastePaths(paths)` → `PASTE_START + paths.map(quote).join(' ') + PASTE_END`, where `quote(p)`
is `p` unchanged when it matches `/^[\w@%+=:,./-]+$/`, else `'` + `p.replaceAll("'", "'\\''")` +
`'`. No trailing space, no Enter. Always bracketed, even for one path: agent TUIs enable
bracketed paste and recognize an image path only as a paste.

The page sends it as one `input` to the pane (`encodeInput(pastePaths(paths))`), after every
image of the gesture has been attached, with the paths in the order of the images. Images that
failed are left out and each gets `errorToast('Attach image failed: <message>')`. When none
succeeded, nothing is sent.

### Page (`devc/web/static/tiles.js`)

Both gestures act on the pane tile's `target()`; when it is `null`, `errorToast("The
terminal isn't connected")` and nothing is sent. Each calls `keepTileOpen(tile)`, as typing does.
After the insertion, keyboard focus goes back to the tile's renderer.

Accepted types are exactly the four `mime` values. Before sending, the page refuses a file over
`MAX_IMAGE_BYTES` (`Attach image failed: <name> is over 20 MB`) without sending it. Images are
attached one at a time, in order (one `call({type: 'attach_image', …})` each).

**Paste** — the existing capturing `paste` listener on the tile body:

1. `text/plain` non-empty → today's text paste, unchanged. **Text wins**: spreadsheets and some
   apps put both text and a picture of it on the clipboard, and the person meant the text.
2. Else the `clipboardData.items` with `kind === 'file'` and an accepted `type` (`getAsFile()`)
   are attached with `source: 'paste'`.
3. Else, when there is a `file` item of another `image/*` type, `errorToast('Only PNG, JPEG, GIF
   and WebP images can be pasted into a terminal')`. Otherwise nothing.

**Drop** — on the tile body:

- `dragover`/`dragenter`: act only when `dataTransfer.types` includes `'Files'` and does **not**
  include `DRAG_MIME` (`lib/view.js`); then `preventDefault()`, `dropEffect = 'copy'`, and add
  class `drop-target` to the tile body. Never `stopPropagation()` and never `preventDefault()`
  for a `DRAG_MIME` drag: Golden Layout's tile drags pass over terminals.
- `dragleave` (when `relatedTarget` is outside the body) and `drop` remove `drop-target`.
- `drop`: `preventDefault()`; `dataTransfer.files` with an accepted `type` are attached with
  `source: 'drop'`. Others are skipped; if any were skipped, one `errorToast('Skipped <n>
  file(s): only PNG, JPEG, GIF and WebP images can be dropped on a terminal')`.

`style.css`: `.tile-body.drop-target` gets an inset 2px outline in the theme's accent color.

## Concept boundaries

- Images only. Dropping other files (to hand an agent a log, say) is not handled.
- No in-page screen capture (`getDisplayMedia`), and no cropping or annotation.
- No image paste into file tiles or diff tiles.
- Nothing is typed besides the bracketed path(s): no Enter, no prompt text.

## Validation

- [x] `cd devc && deno task test` passes, including the new and changed tests below
- [x] `cd devc && deno task check` passes (with `web/images.ts` added to the task's list)
- [x] `deno fmt --check devc` passes; `deno lint` reports nothing new in the touched files
      (`devc` had 256 problems before this plan, mostly `jsr:` import prefixes)
- [x] `web_images_test.ts`: `imageType` recognizes each of the four signatures and returns `null`
      for a 4-byte buffer, a BMP header (`42 4D`) and a `RIFF….WAVE` header;
      `imageFileName('paste', new Date(2026, 9, 29, 15, 4, 5), 'png')` matches
      `/^paste-20261029-150405-[0-9a-f]{6}\.png$/`; the name pattern accepts that name and
      rejects `paste-20261029-150405-a1b2c3.png.bak`, `capture-20261029-150405-a1b2c3.png` and
      `notes.png`
- [x] `web_container_files_test.ts`: the `writeImage` argv carries `dir` and `file` as `$1`/`$2`
      (never inside the script); with a fake `run`, `permission denied` stderr → `forbidden`,
      `is not running` → `not_running`
- [x] `web_host_env_test.ts`: `hostFiles().writeImage` in a temp dir creates the folder `0700` and
      the file `0600` with the exact bytes; a pattern-matching file with its mtime set
      (`Deno.utime`) 8 days back is removed, a 6-day-old one and an 8-day-old `notes.png` are kept
- [x] `web_server_test.ts` (protocol parsing): `attach_image` with each `source`/`mime` parses;
      `source: 'capture'` and `mime: 'image/bmp'` → `bad_request`; a message longer than
      `MAX_IMAGE_MESSAGE` → `message too large`
- [x] `web_images_test.ts` (handler logic, `attachImage` with a fake environment; the server's
      closure has no handler tests to extend, so the handler calls this and only maps errors): a PNG is written to `<home>/.cache/devc/images/paste-…png` and the reply has that
      `path` and `size`; JPEG bytes sent as `mime: 'image/png'` → `bad_request`; `data: '%%%'` →
      `bad_request`; an unknown container → `not_running`; `home()` → `null` → `write_failed`
- [x] `web_input_test.ts`: `pastePaths(['/a/b.png'])` is `'\x1b[200~/a/b.png\x1b[201~'`;
      `pastePaths(['/a/b.png', "/x y/it's.png"])` is
      `'\x1b[200~/a/b.png \'/x y/it\'\\\'\'s.png\'\x1b[201~'`
- [ ] Manual, Chrome, a container project with Claude Code in a pane:
  - [ ] Copy a screenshot (macOS Cmd+Ctrl+Shift+4, or Windows Win+Shift+S) and Cmd/Ctrl+V in
        the pane: `[Image #1]` appears, and the file exists under `~/.cache/devc/images/` in the
        container with mode `600`
  - [ ] Copy cells from a spreadsheet and paste: the text is pasted, no image is attached
  - [ ] Drop two PNGs and a `.txt` on the pane: two images are attached in one paste, and one
        "Skipped 1 file" toast shows
  - [ ] Drag a tile's tab across the pane onto another stack: the layout drag still works, and
        the pane shows no drop highlight
  - [ ] Ask Claude Code what the attached image shows: it describes it
- [ ] Manual, a host project (this machine): paste an image; the file is under the host's
      `~/.cache/devc/images/`
- [ ] Manual, devc-desktop: a screenshot pasted from the OS tool and a dropped PNG are both
      attached
- [ ] Manual, Firefox: paste and drop work

## Relevant Files

- `devc/web/images.ts` (new)
- `devc/web/environment.ts`
- `devc/web/container_files.ts`
- `devc/web/env_host.ts`
- `devc/web/protocol.ts`
- `devc/web/server.ts`
- `devc/web/static/lib/input.js`
- `devc/web/static/tiles.js`
- `devc/web/static/style.css`
- `devc/deno.json` (`check` task)
- `devc/README.md` (devc web **Input** bullet: image paste and drop, where the files go and that they are pruned after 7 days)
- `devc/tests/web_images_test.ts` (new)
- `devc/tests/web_container_files_test.ts`
- `devc/tests/web_host_env_test.ts`
- `devc/tests/web_server_test.ts`
- `devc/tests/web_input_test.ts`
