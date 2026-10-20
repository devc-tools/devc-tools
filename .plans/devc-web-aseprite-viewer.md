# devc-web-aseprite-viewer

## Checklist

- [ ] `static/lib/aseprite.js`: `decodeAseprite(bytes)` and `compositeFrame(sprite, frame, opts)`, written from the public spec only (see "Clean room")
- [ ] `devc/tests/web_aseprite_test.ts`: a test-only `.aseprite` writer, plus decode and composite tests
- [ ] `mediaKind` gains `'aseprite'` (`.aseprite`, `.ase`); `defaultView` is `media` for it
- [ ] Aseprite media view: canvas, zoom, frame scrubber, play/pause, tag picker with loop direction, layer visibility list
- [ ] Unsupported content (tilemap layers, an unknown color depth) shows a clear error overlay, not a blank canvas
- [ ] `devc/README.md` (devc web, "Files and editing") updated

**Depends on [devc-web-media-tiles](archived/devc-web-media-tiles.md)** (`mediaKind`, `view: 'media'`,
and minting preview URLs for a media view).

A file tile renders `.aseprite` / `.ase` sprites. It shows the composited frames, plays animation
with each frame's own duration, and lets you pick a tag and hide layers. It is view-only: no
editing, and no comparison between git revisions.

Read `.claude/skills/devc-web/SKILL.md` first if it exists.

## Clean room

devc-tools has its own decoder, with no runtime or source dependency on any other project.

- Write it **only** from Aseprite's published file-format specification:
  <https://github.com/aseprite/aseprite/blob/main/docs/ase-file-specs.md>.
- Do **not** read, port or adapt any other `.aseprite` decoder's source, including code in other
  folders of this machine's workspace.
- Do not copy `.aseprite` fixture files from elsewhere either. The tests build their own (see
  Verification).
- Name no other project in code, comments or commits.

## Existing touchpoints

- `devc/web/static/lib/media.js` (from devc-web-media-tiles): `mediaKind`, `defaultView`.
- `devc/web/static/app.js`: the media view mount and load path from devc-web-media-tiles. The
  Aseprite view needs the file's **bytes**, so it does `fetch(previewUrl)` →
  `arrayBuffer()`. A same-origin `fetch` is allowed by the page's `connect-src 'self'`.
- `devc/web/static/style.css`: the media view rules.

## Concept boundaries

- **"Frame" vs. "tile".** In this plan a frame is an animation frame of the sprite. Tiles stay
  `devc web`'s layout tiles. Aseprite *tilemap* layers (layer type 2) are unsupported, so the
  decoder never says "tile" in any other sense than in its error message.
- **Layer visibility here is view state.** Unchecking a layer hides it in this tile only. It
  never touches the file, and it overrides the file's own *visible* flag. That flag is only the
  initial state.

## Contracts

### `static/lib/aseprite.js`

```js
/**
 * @typedef {{r: number, g: number, b: number, a: number}} Rgba
 * @typedef {{index: number, name: string, type: 'normal' | 'group', childLevel: number,
 *   visible: boolean, opacity: number, blendMode: number, parent: number | null}} AseLayer
 * @typedef {{layer: number, frame: number, x: number, y: number, opacity: number,
 *   zIndex: number, width: number, height: number, pixels: Uint8ClampedArray}} AseCel
 *   pixels: RGBA, already converted from the sprite's color depth
 * @typedef {{name: string, from: number, to: number,
 *   direction: 'forward' | 'reverse' | 'pingpong' | 'pingpong_reverse', repeat: number}} AseTag
 * @typedef {{width: number, height: number, colorDepth: 8 | 16 | 32,
 *   transparentIndex: number, palette: Rgba[], layers: AseLayer[],
 *   frames: {durationMs: number, cels: AseCel[]}[], tags: AseTag[]}} AseSprite
 */
/** Throws AseError (message for the overlay) on a bad magic number, truncation, or unsupported content. */
export async function decodeAseprite(bytes /* Uint8Array */) /* : Promise<AseSprite> */
/** RGBA of one frame at sprite size; hidden: layer indices to skip (and their children). */
export function compositeFrame(sprite, frame, { hidden = new Set() } = {}) /* : ImageData-shaped {width, height, data} */
export class AseError extends Error {}
```

Required coverage, all from the spec:

- **Header.** Magic `0xA5E0`, frames, size, color depth, flags, transparent index, color count.
  Honour the header flag that says layer opacity is valid.
- **Frames.** Magic `0xF1FA`, duration, and the old and new chunk count fields.
- **Chunks.**
  - Layer `0x2004`.
  - Cel `0x2005`: types 0 (raw), 1 (linked: copies the referenced frame's cel), 2
    (zlib-compressed); type 3 (compressed tilemap) → `AseError('Tilemap layers aren't
    supported')`.
  - Cel extra `0x2006`: may be ignored.
  - Palette `0x2019`, plus the old palette chunks `0x0004` / `0x0011` when no `0x2019` is
    present.
  - Tags `0x2018`.
  - Unknown chunk types are skipped by their size.
- **Pixels.**
  - RGBA (32).
  - Grayscale (16): value and alpha.
  - Indexed (8): through the palette, with `transparentIndex` transparent on non-background
    layers.
- **Decompression.** `DecompressionStream('deflate')`, available in browsers and in Deno for the
  tests. No zlib library is vendored.
- **Compositing.**
  - Layers from bottom to top, each cel at its `x`, `y`.
  - Effective opacity = cel opacity × layer opacity (when valid) × each ancestor group's
    opacity.
  - Hidden ancestors hide their children.
  - **Normal** blend (source-over) for every layer. Other blend modes draw as normal, and the
    view says so once ("Blend modes shown as Normal") when any layer uses one. Real blend modes
    are a follow-on.
  - Cel `zIndex` reordering (when the spec's field is present) is applied as the spec
    describes.

### The view

- **Canvas.**
  - Drawn with `putImageData` at 1×, then CSS-scaled with `image-rendering: pixelated`.
  - Zoom is an integer: **fit** (the default: the largest integer scale that fits, at least 1),
    or `−` / `+` buttons and Ctrl/⌘+wheel.
  - Checkerboard behind transparency.
- **Frame bar.**
  - A scrubber or strip of frame numbers, the current frame `n / N`, and play/pause.
  - Space toggles play while the tile is focused; `,` / `.` step one frame.
  - Playback uses each frame's `durationMs`, with a `setTimeout` chain and no fixed rate.
- **Tags.**
  - A `<select>`: *All frames* (the default), then each tag.
  - Choosing a tag plays only `from…to`, in its `direction`. Ping-pong does not repeat the end
    frames.
- **Layers.**
  - A collapsible list, top layer first and indented by `childLevel`, with a checkbox per layer.
  - It starts from each layer's `visible` flag.
  - Changes recomposite the current frame.
- **Lifecycle.**
  - Play stops when the tile is hidden (its Golden Layout container not visible) or closed.
  - **Reload** re-fetches, decodes again, and keeps the frame index, zoom and layer choices when
    the layer names still match.
  - Decoding and compositing are cheap at sprite sizes. Composited frames may be cached per
    `(frame, hidden set)` and cleared on reload or a visibility change.
- **Errors.** `AseError` → the tile's error overlay with its message. Any other throw → "Couldn't
  read <name> as an Aseprite file" and the message.

## Verification

- `devc/tests/web_aseprite_test.ts` includes a **test-only writer**. It is a small function in the
  test file, written from the same spec, and builds `.aseprite` bytes with
  `CompressionStream('deflate')`. With it, tests cover:
  - RGBA, grayscale and indexed sprites, including the transparent index;
  - raw, compressed and linked cels;
  - a group with a hidden parent and with group opacity;
  - layer opacity with the header flag on and off;
  - multiple frames with distinct durations;
  - tags with each direction;
  - an unknown chunk skipped;
  - a tilemap cel rejected with `AseError`;
  - a truncated file rejected with `AseError`.

  Each composite test checks exact pixels.
- If the user supplies real `.aseprite` files, open them by hand in `devc web --live`. Check
  animation timing, tag playback, layer toggles, fit and zoom, and that a file with a non-normal
  blend mode shows the note.
