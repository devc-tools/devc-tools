// The orchestrator panel (`.plans/devc-web-orchestrator.md`): docked on the right of the tiling
// area in `/` and `/main`, outside its layout, showing one running container's orchestrator, a Pi
// session that routes a prompt to one of the container's repos and starts an agent there. The
// first open for a container starts it (the server's `orchestrator` request); the panel draws its
// pane with its own terminal, never a tile, so it is in no tile list, and the sidebar leaves the
// pane out of its lists (`lib/orchestrator.js`'s `isOrchestratorPane`).
//
// Its button sits in the tiling area's top-right corner, beside the zen button, and shows a dot
// while the panel is closed and an orchestrator waits on the person. `tiles.js` mounts it;
// `main-page.js` toggles it for devc-desktop's **View → Orchestrator** (`toggleOrchestrator`).

import { createRenderer } from './renderer.js';
import { attachTerminalMouse } from './term_mouse.js';
import {
  createWheelAccumulator,
  decodeBase64,
  encodeInput,
  wrapPaste,
} from './lib/input.js';
import {
  clampOrchestratorWidth,
  isOrchestratorPane,
  ORCHESTRATOR_CONTAINER_KEY,
  ORCHESTRATOR_DEFAULT_WIDTH,
  ORCHESTRATOR_OPEN_KEY,
  ORCHESTRATOR_WIDTH_KEY,
  orchestratorOverlays,
  orchestratorWaiting,
  pickOrchestratorContainer,
} from './lib/orchestrator.js';
import {
  call,
  containers,
  displayName,
  findPane,
  list,
  nextId,
  onServerMessage,
  send,
  snapshots,
} from './client.js';
import { errorToast, h, iconButton, IS_MAC, writeClipboard } from './ui.js';

const RESIZE_DEBOUNCE_MS = 100;
/** How long a new pane may take to show in Herdr's snapshot before the panel gives up. */
const LISTED_TIMEOUT_MS = 15_000;

/** The mounted panel's toggle, once `tiles.js` has mounted it. */
let mounted = /** @type {(() => void) | null} */ (null);

/** Opens the orchestrator panel, or closes it (devc-desktop's **View → Orchestrator**). */
export function toggleOrchestrator() {
  mounted?.();
}

/** @param {string} key @returns {string | null} */
function load(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** @param {string} key @param {string} value */
function save(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable: it just won't survive a reload */ }
}

/**
 * Mounts the panel in `app` beside `tiles`, and its button in `tiles`' top-right corner.
 *
 * @param {HTMLElement} app    the page's `.app`
 * @param {{tiles: HTMLElement, focusedFolder: () => string | null}} opts
 *   `focusedFolder`: the focused tile's project, the container it shows when none was picked
 *   before.
 */
export function mountOrchestrator(app, opts) {
  let open = load(ORCHESTRATOR_OPEN_KEY) === '1';
  let width = Number(load(ORCHESTRATOR_WIDTH_KEY)) ||
    ORCHESTRATOR_DEFAULT_WIDTH;
  /** The picked container's `localFolder`. */
  let picked = load(ORCHESTRATOR_CONTAINER_KEY);
  /** The pane drawn, while attached. @type {{container: string, pane_id: string} | null} */
  let attached = null;
  /** The pane wanted: the last request's answer, kept across reconnects. */
  let wanted = /** @type {{container: string, pane_id: string} | null} */ (
    null
  );
  let openId = /** @type {string | null} */ (null);
  /** When `wanted` was set, to give up on a pane that never shows. */
  let wantedSince = 0;
  let listedTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (
    undefined
  );
  let pending = false;
  /** Whether a `containers` message has come since loading. */
  let containersListed = false;
  let frames = 0;
  /** @type {{cols: number, rows: number} | null} */
  let size = null;
  let resizeTimer = /** @type {ReturnType<typeof setTimeout> | undefined} */ (
    undefined
  );

  const $title = h('span', { class: 'orchestrator-title' }, 'Orchestrator');
  const $picker = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'orchestrator-picker',
    'aria-label': 'Container',
    onchange: () => {
      picked = $picker.value;
      save(ORCHESTRATOR_CONTAINER_KEY, picked);
      detach();
      wanted = null;
      void start('open');
    },
  }));
  const $restart = iconButton(
    'refresh',
    'Restart (same conversation)',
    () => void start('restart'),
  );
  const $new = iconButton('plus', 'New session', () => void start('new'));
  const $close = iconButton('close', 'Close', () => toggle());
  const $term = h('div', { class: 'term' });
  const $note = h('div', { class: 'orchestrator-note', hidden: true });
  const $body = h('div', { class: 'orchestrator-body' }, $term, $note);
  const $resizer = h('div', {
    class: 'orchestrator-resizer',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize orchestrator',
    title: 'Drag to resize, double-click to reset',
  });
  const $panel = h(
    'section',
    { class: 'orchestrator', 'aria-label': 'Orchestrator', hidden: true },
    $resizer,
    h(
      'header',
      { class: 'orchestrator-header' },
      $title,
      $picker,
      h('span', { class: 'orchestrator-spacer' }),
      $restart,
      $new,
      $close,
    ),
    $body,
  );
  app.append($panel);
  const $button = h('button', {
    class: 'sidebar-toggle orchestrator-toggle',
    type: 'button',
    'aria-pressed': 'false',
    'aria-label': 'Orchestrator',
    title: 'Orchestrator',
    onclick: () => toggle(),
  });
  $button.append(chatIcon());
  opts.tiles.append($button);

  /** Marks the button while the panel is closed and an orchestrator waits on the person. */
  function renderButton() {
    $button.setAttribute('aria-pressed', String(open));
    const waiting = !open &&
      [...containers.values()].some((c) =>
        c.state === 'connected' &&
        list(snapshots.get(c.id)?.panes).some((p) =>
          isOrchestratorPane(p) && orchestratorWaiting(p)
        )
      );
    $button.toggleAttribute('data-waiting', waiting);
  }

  const renderer = createRenderer($term, {
    linkHint: `${IS_MAC ? 'Cmd' : 'Ctrl'}+click to open`,
    linkModifier: isLinkModifier,
    openUrl: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
  });

  renderer.onData((data) => {
    if (attached) {
      send({ type: 'input', ...attached, bytes: encodeInput(data) });
    }
  });
  const wheelToScroll = createWheelAccumulator();
  renderer.onWheel((ev) => {
    const m = renderer.metrics();
    if (!attached || !m) return;
    const scroll = wheelToScroll(ev.deltaY, m.cellHeight, ev.deltaMode);
    if (scroll) send({ type: 'scroll', ...attached, ...scroll });
  });
  $body.addEventListener('paste', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (text && attached) {
      send({ type: 'input', ...attached, bytes: encodeInput(wrapPaste(text)) });
    }
  }, true);
  attachTerminalMouse($term, renderer, {
    mouse: (cmd) => {
      if (attached) send({ type: 'mouse', ...attached, ...cmd });
    },
    copyRange: (anchor, cursor) => {
      if (!attached) return;
      const text = call({ type: 'read_selection', ...attached, anchor, cursor })
        .then((r) => String(/** @type {any} */ (r)?.text ?? ''));
      writeClipboard(text).catch((e) =>
        errorToast(`Copy failed: ${e?.message ?? e}`)
      );
    },
    openLink: (link) => {
      if (link.kind === 'url') {
        window.open(link.url, '_blank', 'noopener,noreferrer');
      }
    },
    contextMenu: () => {},
    frames: () => frames,
    linkModifier: isLinkModifier,
    active: () => attached !== null,
  });

  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, RESIZE_DEBOUNCE_MS);
  }).observe($body);

  function refit() {
    if (!open) return;
    const next = renderer.resize();
    if (!next) return;
    if (size && next.cols === size.cols && next.rows === size.rows) return;
    size = next;
    if (attached) send({ type: 'resize', ...attached, ...next });
  }

  /** The running containers the picker offers (host sessions have no orchestrator). */
  function running() {
    return [...containers.values()].filter((c) => c.kind !== 'host');
  }

  function current() {
    return pickOrchestratorContainer(running(), picked, opts.focusedFolder());
  }

  function renderPicker() {
    const list = running();
    const c = current();
    $picker.replaceChildren(
      ...list.map((x) => h('option', { value: x.localFolder }, displayName(x))),
    );
    if (c) $picker.value = c.localFolder;
    $picker.hidden = list.length < 2;
    $restart.toggleAttribute('disabled', !c);
    $new.toggleAttribute('disabled', !c);
  }

  /** @param {string} text @param {(() => void) | null} [retry] */
  function note(text, retry = null) {
    $note.replaceChildren(
      h('p', {}, text),
      ...(retry ? [h('button', { onclick: retry }, 'Retry')] : []),
    );
    $note.hidden = text === '';
  }

  function layout() {
    const room = opts.tiles.getBoundingClientRect().width;
    const w = clampOrchestratorWidth(width, room || width);
    app.style.setProperty('--orchestrator-width', `${w}px`);
    const overlay = room > 0 && orchestratorOverlays(w, room);
    app.dataset.orchestrator = !open
      ? 'closed'
      : overlay
      ? 'overlay'
      : 'docked';
    app.style.setProperty(
      '--orchestrator-room',
      open && !overlay ? `${w}px` : '0px',
    );
  }

  function detach() {
    if (attached) send({ type: 'close', ...attached });
    attached = null;
    openId = null;
  }

  /** @param {{container: string, pane_id: string}} pane */
  function attach(pane) {
    if (
      attached && attached.container === pane.container &&
      attached.pane_id === pane.pane_id
    ) return;
    detach();
    attached = pane;
    frames = 0;
    size = renderer.resize() ?? { cols: 80, rows: 24 };
    openId = nextId('o');
    send({ type: 'open', id: openId, ...pane, ...size });
    note('');
    renderer.focus();
  }

  /** Attaches the wanted pane once the page's snapshot lists it. */
  function attachWhenListed() {
    clearTimeout(listedTimer);
    if (!open || !wanted || attached) return;
    if (findPane(wanted.container, wanted.pane_id)) {
      attach(wanted);
      return;
    }
    if (Date.now() - wantedSince > LISTED_TIMEOUT_MS) {
      wanted = null;
      note("The orchestrator's pane didn't appear.", () => void start('open'));
      return;
    }
    // Snapshots drive this; the timer only catches a pane that never shows.
    listedTimer = setTimeout(attachWhenListed, 1000);
  }

  /** @param {'open' | 'restart' | 'new'} mode */
  async function start(mode) {
    renderPicker();
    const c = current();
    if (!c) {
      detach();
      // Before the first `containers` message nothing is listed yet: that one starts it.
      note(
        containersListed ? 'No running container.' : 'Connecting to devc web…',
      );
      return;
    }
    if (pending) return;
    pending = true;
    if (mode !== 'open') detach();
    note('Starting the orchestrator…');
    try {
      const r = /** @type {any} */ (await call({
        type: 'orchestrator',
        container: c.id,
        mode,
      }));
      if (current()?.id !== c.id) return;
      wanted = { container: c.id, pane_id: String(r.pane_id) };
      // The server opens only panes its snapshot lists, and a new one shows in a later
      // snapshot: attach once it is listed (`snapshot` below), or give up after a while.
      wantedSince = Date.now();
      attachWhenListed();
    } catch (e) {
      note(
        /** @type {any} */ (e)?.message ?? String(e),
        () => void start('open'),
      );
    } finally {
      pending = false;
    }
  }

  function show() {
    $panel.hidden = !open;
    layout();
    if (open) {
      renderPicker();
      if (attached) renderer.focus();
      else void start('open');
      queueMicrotask(refit);
    } else detach();
  }

  function toggle() {
    open = !open;
    save(ORCHESTRATOR_OPEN_KEY, open ? '1' : '0');
    show();
    renderButton();
  }

  onServerMessage((msg) => {
    if (msg.type === 'containers') containersListed = true;
    if (
      msg.type === 'snapshot' || msg.type === 'agent_status' ||
      msg.type === 'containers'
    ) renderButton();
    switch (msg.type) {
      case 'hello':
        // A reconnect: the server forgot the open; ask again (it may have a new pane by now).
        attached = null;
        if (open) void start('open');
        break;
      case 'containers':
        if (!open) break;
        renderPicker();
        if (attached && !containers.has(attached.container)) {
          attached = null;
          void start('open');
        } else if (!attached && !wanted && !pending && current()) {
          // `hello` comes before the containers are listed: start once they are.
          void start('open');
        }
        break;
      case 'snapshot':
        attachWhenListed();
        break;
      case 'frame':
        if (
          attached && msg.container === attached.container &&
          msg.pane_id === attached.pane_id
        ) {
          renderer.write(decodeBase64(msg.bytes), msg.cols, msg.rows);
          frames++;
        }
        break;
      case 'pane_closed':
        if (
          attached && msg.container === attached.container &&
          msg.pane_id === attached.pane_id
        ) {
          attached = null;
          wanted = null;
          note('The orchestrator stopped.', () => void start('open'));
        }
        break;
      case 'result':
        if (msg.id === openId && !msg.ok) {
          attached = null;
          note(
            msg.error?.message ?? 'Could not show the orchestrator',
            () => void start('open'),
          );
        }
        break;
    }
  });

  // The handle drags with pointer capture, so the tiles and terminals never see the move.
  $resizer.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    $resizer.setPointerCapture(ev.pointerId);
    document.body.classList.add('resizing-orchestrator');
    const right = $panel.getBoundingClientRect().right;
    const onMove = (/** @type {PointerEvent} */ e) => {
      width = clampOrchestratorWidth(
        right - e.clientX,
        opts.tiles.getBoundingClientRect().width,
      );
      layout();
    };
    const onEnd = () => {
      $resizer.removeEventListener('pointermove', onMove);
      $resizer.removeEventListener('lostpointercapture', onEnd);
      document.body.classList.remove('resizing-orchestrator');
      save(ORCHESTRATOR_WIDTH_KEY, String(width));
    };
    $resizer.addEventListener('pointermove', onMove);
    $resizer.addEventListener('lostpointercapture', onEnd);
  });
  $resizer.addEventListener('dblclick', () => {
    width = ORCHESTRATOR_DEFAULT_WIDTH;
    save(ORCHESTRATOR_WIDTH_KEY, String(width));
    layout();
  });
  window.addEventListener('resize', layout);

  // Before the first `hello`, no container is known: `hello` starts it.
  $panel.hidden = !open;
  renderPicker();
  if (open) note('Connecting to devc web…');
  layout();
  renderButton();
  mounted = toggle;
}

/** Whether the key that opens terminal links is down during `ev`. */
function isLinkModifier(/** @type {MouseEvent | KeyboardEvent} */ ev) {
  return IS_MAC ? ev.metaKey : ev.ctrlKey;
}

/** A speech bubble: the button's icon. */
function chatIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2.5 3h11v7.5h-6l-3 2.5v-2.5h-2z');
  svg.append(path);
  return svg;
}
