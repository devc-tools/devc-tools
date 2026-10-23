// The `devc web` page's DOM helpers and widgets, shared by the sidebar (`sidebar.js`) and the
// tiling area (`tiles.js`): `h`, toasts, menus, the confirm and prompt dialogs (never the
// browser's), icons and row parts, the labels the page shows (`LABELS`), and the release of
// `boot.js`'s guard.

import { agentStatus, statusShort } from './lib/sidebar.js';
import { AGENT_MARKS, terminalIconKind } from './lib/agent_icons.js';
import { trimDividers } from './lib/menu.js';
import { splitMarkers } from './lib/pr_tree.js';
import { hostOs } from './client.js';

/** Set once the first `containers` has rendered: `client_ready` sent, boot guard released. */
export let booted = false;
const $menu = /** @type {HTMLElement} */ (document.getElementById('menu'));
const $toasts = /** @type {HTMLElement} */ (document.getElementById('toasts'));

/** @param {string} tag @param {Record<string, any>} [attrs] @param {...(Node|string)} children */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  el.append(...children);
  return el;
}

/**
 * A message in the corner for a few seconds. With `action`, it carries a button that runs it
 * (and dismisses the toast), and stays a little longer. Returns the toast's element.
 *
 * @param {string} message @param {{label: string, run: () => void}} [action]
 */
export function toast(message, action) {
  const el = h('div', { class: 'toast' }, message);
  if (action) {
    el.append(h('button', {
      type: 'button',
      class: 'toast-action',
      onclick: () => {
        el.remove();
        action.run();
      },
    }, action.label));
  }
  $toasts.append(el);
  setTimeout(() => el.remove(), action ? 12000 : 6000);
  return el;
}

/** A {@link toast} for a failure: outlined as an error. @param {string} message */
export function errorToast(message) {
  toast(message).classList.add('error');
}

/** Releases `boot.js`'s guard: from here on, errors are toasts, not its overlay. */
export function markBooted() {
  if (booted) return;
  booted = true;
  /** @type {any} */ (window).__devcBooted?.();
}

window.addEventListener('error', (e) => {
  if (booted && e.message) errorToast(e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  if (booted) errorToast(String(e.reason?.message ?? e.reason));
});

/** A pane's agent status as a dot and its short word; the agent's name and full status are in the tooltip. */
export function badge(pane) {
  if (!pane?.agent) return '';
  const status = agentStatus(pane);
  return h(
    'span',
    {
      class: 'badge',
      'data-status': status,
      title: `${pane.agent}: ${status}`,
    },
    statusShort(status),
  );
}
/**
 * User-visible names for what the sidebar lists under a container. A *terminal* is a Herdr
 * pane: code and protocol keep saying `pane`, the page says "terminal". Kept here so a rename
 * is one edit.
 */
export const LABELS = {
  files: 'Files',
  newTerminalHere: 'New terminal here',
  newFile: 'New file…',
  newFolder: 'New folder…',
  renameEntry: 'Rename…',
  deleteEntry: 'Delete…',
  copyPath: 'Copy path',
  copyContainerPath: 'Copy container path',
  openInCode: 'Open in Code',
  openInJira: (key) => `Open ${key} in Jira`,
  /** Renders a file in a media view; not a preview tile (`keepOpen`), whatever the name. */
  preview: 'Preview',
  previewRight: 'Preview to the right',
  openAsText: 'Open as text',
  /** Read when a menu opens: named for the host's file manager. */
  get reveal() {
    return hostOs === 'darwin'
      ? 'Reveal in Finder'
      : hostOs === 'windows'
      ? 'Reveal in File Explorer'
      : 'Open containing folder';
  },
  /** Pinned files; never "pin" alone, which a project and a preview tile also use. */
  pinned: 'Pinned',
  pinFile: 'Pin file',
  unpinFile: 'Unpin file',
  newNote: 'New note…',
  tasks: 'Tasks',
  newTask: 'New task…',
  newTaskHere: 'New task here…',
  pinTaskDefault: 'Make these the default for new tasks',
  unpinTaskDefault: 'Default for new tasks: click to clear',
  collapseAll: 'Collapse all',
  noTasks: 'No tasks',
  sentTasks: 'Sent',
  notRouted: 'not routed',
  notRunning: 'The container is not running',
  plainTerminal: 'Terminal',
  /** The + menu's agents (ids from `lib/agent_icons.js`). */
  agents: {
    claude: 'Claude',
    copilot: 'Copilot',
    pi: 'Pi',
    opencode: 'OpenCode',
  },
  refreshSessions: 'Refresh sessions',
  refreshContainers: 'Refresh containers',
  resumeSession: 'Resume session',
  showPastSessions: (n) => `Show past sessions (${n})`,
  hidePastSessions: 'Hide past sessions',
  worktreesHidden: (n) => `${n} worktree${n === 1 ? '' : 's'} hidden`,
  copySessionId: 'Copy session id',
  pullRequest: 'Pull request',
  openHere: 'Open terminal here',
  newTerminal: 'New terminal',
  splitRight: 'Split vertically',
  splitBelow: 'Split horizontally',
  newInStack: 'New terminal in this stack',
  newAtEnd: 'New terminal at end',
  close: 'Close terminal…',
  keepOpen: 'Keep open',
  zenOn: 'Zen mode',
  zenOff: 'Leave zen mode',
  zenScope: { container: 'Zen scope: container', repo: 'Zen scope: repo' },
  closeRequest: 'Close terminal',
  rename: 'Rename terminal',
  renamePrompt: 'Terminal name',
  closed: 'Terminal closed',
  clickToOpen: 'Click a terminal in the sidebar to open it here.',
  dragHere: 'Drag a terminal here, or click one in the sidebar.',
};

export function chevron() {
  return h('span', { class: 'chevron', 'aria-hidden': 'true' });
}

/** A row's right-hand side: its badge, then buttons shown on hover. */
export function rowTrail(...children) {
  return h('span', { class: 'row-trail' }, ...children);
}

/**
 * A row's hover buttons. They show over the row's right end rather than beside its badge, so
 * nothing on the row moves when they appear.
 */
export function hoverActions(...buttons) {
  return h('span', { class: 'row-hover' }, ...buttons);
}

const ICON_PATHS = {
  close: 'M4 4l8 8M12 4l-8 8',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4',
  plus: 'M8 3v10M3 8h10',
  pin: 'M5.5 2.5h5M6.5 2.5v4L4.5 9h7l-2-2.5v-4M8 9v4.5',
  play: 'M5.5 3.5v9l7-4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  project: 'M8 2.5l5 2.75v5.5L8 13.5l-5-2.75v-5.5zM3 5.25L8 8l5-2.75M8 8v5.5',
  // A window with a `>_` prompt: a shell.
  terminal: 'M2 3h12v10H2zM4.5 6.5L6.5 8l-2 1.5M8 10.5h3',
  // A robot head: an agent without a mark of its own.
  agent: 'M3 6h10v7H3zM8 3v3M6 9.5v.01M10 9.5v.01M1.5 9v1.5M14.5 9v1.5',
  // A page with a folded corner: a file tile.
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  // A page of lines: send a task for a plan.
  plan: 'M4 2h8v12H4zM6 5h4M6 7.5h4M6 10h2.5',
  // `</>`: send a task to be implemented.
  implement: 'M5.5 5L2.5 8l3 3M10.5 5l3 3-3 3M9 3.5l-2 9',
  // A checklist: a new task.
  task: 'M3 4l1.2 1.2L6.5 3M8.5 4.5H13M3 9l1.2 1.2L6.5 8M8.5 9.5H13',
  // Two stacked squares, a minus on the front one: a section's Collapse all (VS Code's).
  collapseAll: 'M5.5 2.5h8v8M2.5 5.5h8v8h-8zM4.5 9.5h4',
  // A circular arrow: list again.
  refresh: 'M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3',
  // A clock, its rim an arrow turning back: past sessions.
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5',
  // An arrow out of a box: open on github.com.
  external: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  // Two commits on a line, a third's line curving back into it: a repo card's pull request.
  pullRequest:
    'M3 3.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M3 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0' +
    'M10 12.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H7.5' +
    'M9 3L7.5 4.5L9 6',
  // A folder with a tab: a repo card's files.
  folder: 'M1.5 3.5h5L8 5h6.5v8h-13z',
};

/**
 * A 14px leading icon for a terminal (its pane's `agent`: that agent's mark, a generic agent
 * glyph, or a shell's) or, with `kind` 'file', for a file tile.
 *
 * @param {{agent?: string | null, kind?: 'file', empty?: boolean}} what
 */
export function rowIcon({ agent, kind, empty }) {
  const which = kind ?? terminalIconKind(agent);
  let svg;
  if (which === 'terminal' || which === 'agent' || which === 'file') {
    svg = svgIcon(which);
    svg.setAttribute('data-stroked', '');
  } else {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of AGENT_MARKS[which].paths) {
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      );
      path.setAttribute('d', d);
      svg.append(path);
    }
  }
  return h(
    'span',
    {
      class: 'term-icon',
      'data-kind': which,
      'data-empty': empty || undefined,
    },
    svg,
  );
}

/** @param {keyof ICON_PATHS} icon */
export function svgIcon(icon) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[icon]);
  svg.append(path);
  return svg;
}

/**
 * A small icon button for a sidebar row, shown on hover. It stops its clicks (and the
 * mousedown that would start a Golden Layout drag) from reaching the row.
 *
 * @param {keyof ICON_PATHS} icon @param {string} title @param {() => void} action
 */
export function iconButton(icon, title, action) {
  const svg = svgIcon(icon);
  const stop = (e) => e.stopPropagation();
  return h('button', {
    type: 'button',
    class: 'icon-btn',
    'data-icon': icon,
    title,
    'aria-label': title,
    onmousedown: stop,
    onpointerdown: stop,
    onclick: (e) => {
      e.stopPropagation();
      action();
    },
  }, svg);
}

/** `text` with its bidi controls and zero-width characters shown as markers (`splitMarkers`). */
export function markedText(text) {
  return splitMarkers(String(text ?? '')).map((part) =>
    typeof part === 'string' ? part : h('span', {
      class: 'invisible-mark',
      title: 'An invisible or direction-changing character',
    }, part.marker)
  );
}

/** `+a −d`. */
export function diffStat(file) {
  return `+${file.additions} −${file.deletions}`;
}

// ---------------------------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------------------------

/**
 * Asks a yes/no question in a modal `<dialog>`, never the browser's `confirm()`: the desktop app
 * shows devc web with native dialogs turned off, where `confirm()` would answer no unasked.
 * Resolves true on the OK button (or Enter on it), false on Cancel or Escape.
 *
 * @param {string} message
 * @param {{okLabel?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(
  message,
  { okLabel = 'OK', danger = false } = {},
) {
  return askDialog(message, null, okLabel, danger).then((v) => v !== null);
}

/**
 * Asks for a line of text in a modal `<dialog>`, never the browser's `prompt()` (see
 * {@link confirmDialog}). Resolves the text on OK or Enter, `null` on Cancel or Escape.
 *
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string | null>}
 */
export function promptDialog(message, defaultValue = '') {
  return askDialog(message, defaultValue, 'OK', false);
}

/**
 * The one dialog behind {@link confirmDialog} and {@link promptDialog}: with `value` (a string)
 * it has a text field. Resolves the field's text (`''` without one) on OK, `null` otherwise. The
 * message is text, never markup.
 *
 * @param {string} message @param {string | null} value
 * @param {string} okLabel @param {boolean} danger
 * @returns {Promise<string | null>}
 */
function askDialog(message, value, okLabel, danger) {
  return new Promise((resolve) => {
    let answer = null;
    const $input = value === null ? null : /** @type {HTMLInputElement} */ (h(
      'input',
      {
        type: 'text',
        class: 'ask-input',
        spellcheck: 'false',
        autocomplete: 'off',
        'aria-label': message,
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          ok();
        },
      },
    ));
    if ($input) $input.value = value ?? '';
    const ok = () => {
      answer = $input ? $input.value : '';
      el.close();
    };
    const $ok = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      class: danger ? 'primary danger' : 'primary',
      onclick: ok,
    }, okLabel));
    const el = /** @type {HTMLDialogElement} */ (h(
      'dialog',
      {
        class: 'dialog ask',
        'aria-label': message,
        onclose: () => {
          el.remove();
          resolve(answer);
        },
      },
      h(
        'div',
        { class: 'ask-body' },
        h('p', { class: 'ask-message' }, message),
        $input,
      ),
      h(
        'footer',
        { class: 'dialog-footer ask-footer' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $ok,
      ),
    ));
    document.body.append(el);
    el.showModal();
    if ($input) {
      $input.focus();
      $input.select();
    } else {
      $ok.focus();
    }
  });
}

export function copyText(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(`Copied ${text}`),
    (e) => errorToast(`Copy failed: ${e?.message ?? e}`),
  );
}

/** @typedef {[string, () => void, boolean?, Node?] | null} MenuItem  null: a divider */

/** @param {MouseEvent} e @param {MenuItem[]} items */
export function openMenu(e, items) {
  e.preventDefault();
  openMenuAt(e.clientX, e.clientY, items);
}

/**
 * The menu at (`x`, `y`), kept inside the window. An item may carry an icon (a fourth element)
 * shown before its label; a `null` item is a divider between groups (see {@link trimDividers}).
 *
 * @param {number} x @param {number} y
 * @param {MenuItem[]} items
 */
export function openMenuAt(x, y, items) {
  $menu.replaceChildren(
    ...trimDividers(items).map((item) => {
      if (item === null) {
        return h('div', { class: 'menu-sep', role: 'separator' });
      }
      const [label, action, danger, icon] = item;
      return h(
        'button',
        {
          class: danger ? 'danger' : undefined,
          onclick: () => {
            closeMenu();
            action();
          },
        },
        icon ?? '',
        label,
      );
    }),
  );
  $menu.hidden = false;
  const { innerWidth, innerHeight } = window;
  const rect = $menu.getBoundingClientRect();
  $menu.style.left = `${Math.min(x, innerWidth - rect.width - 4)}px`;
  $menu.style.top = `${Math.min(y, innerHeight - rect.height - 4)}px`;
}

function closeMenu() {
  $menu.hidden = true;
}

// Capture phase: a terminal stops its own mousedowns and keys from bubbling.
document.addEventListener('mousedown', (e) => {
  if (!$menu.hidden && !$menu.contains(/** @type {Node} */ (e.target))) {
    closeMenu();
  }
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
}, true);

/**
 * Writes text that is still on its way to the clipboard. The write starts now, inside the
 * mouseup, with a promise-valued `ClipboardItem`: Safari and Firefox would drop the user
 * activation across the wait for the server. Empty text copies nothing.
 *
 * @param {Promise<string>} text
 */
export async function writeClipboard(text) {
  const clipboard = navigator.clipboard;
  if (!clipboard) throw new Error('clipboard unavailable');
  if (typeof ClipboardItem === 'undefined') {
    const t = await text;
    if (t) await clipboard.writeText(t);
    return;
  }
  const blob = text.then((t) => {
    if (!t) throw new Error('empty');
    return new Blob([t], { type: 'text/plain' });
  });
  try {
    await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
  } catch (e) {
    // The reply's own error wins; an empty selection is not a failure.
    if (await text) throw e;
  }
}

/** Mac's link modifier is Cmd; elsewhere it is Ctrl (as in VS Code's terminal). */
export const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
