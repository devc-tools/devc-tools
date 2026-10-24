// The `devc web` Ask agent dialog: a question about the file in a file or diff tile, for an agent
// running in a terminal at the file's repo, a past session of the repo (resumed on it), or a new
// session there (`ask_agent`). The agent's terminal then shows to the right of the tile, or comes
// forward where it is already shown. The text and the targets come from `lib/ask.js`; `tiles.js`
// opens the dialog with what the tile shows and has selected.

import {
  askTargetFields,
  askTargets,
  askText,
  askWhere,
  defaultAskTarget,
  MAX_ASK_TEXT,
} from './lib/ask.js';
import { parseSessions } from './lib/sessions.js';
import { labelText, paneLabel } from './lib/sidebar.js';
import { h, IS_MAC, LABELS, toast } from './ui.js';
import {
  call,
  containerByFolder,
  list,
  paneRepo,
  projects,
  projectStarts,
  snapshots,
} from './client.js';
import { placePane, startProject } from './menus.js';

/** @typedef {import('./lib/ask.js').AskContext} AskContext */
/** @typedef {import('./lib/ask.js').AskTarget} AskTarget */

/** Where the target last asked from each repo is kept, per browser: `{[root]: key}`. */
const TARGET_KEY = 'devc-web-ask-target-v1';

/** Each container's last `list_sessions` answer, by container id, for the picker's first look. */
const lastSessions = new Map();

/** The open dialog, so a second Ask closes the first. @type {HTMLDialogElement | null} */
let open = null;

function savedTargets() {
  try {
    const v = JSON.parse(localStorage.getItem(TARGET_KEY) ?? '{}');
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function saveTarget(root, key) {
  try {
    localStorage.setItem(
      TARGET_KEY,
      JSON.stringify({ ...savedTargets(), [root]: key }),
    );
  } catch { /* storage unavailable: the next dialog starts on the default */ }
}

/** The agents running in container `c`'s terminals at repo `root` of project `localFolder`. */
function agentPanes(c, localFolder, root) {
  return list(snapshots.get(c.id)?.panes)
    .filter((p) => p.agent && paneRepo(localFolder, p)?.folder === root)
    .map((p) => ({
      pane_id: p.pane_id,
      agent: p.agent,
      label: labelText(paneLabel(p)),
    }));
}

/**
 * Asks a question about a repo file: opens the dialog. `at` is the tile it was asked from, which
 * the agent's terminal opens to the right of; `root` the repo's host folder; `context` what the
 * question is about.
 *
 * @param {{at: string, localFolder: string, root: string, context: AskContext}} opts
 */
export function openAskDialog({ at, localFolder, root, context }) {
  const c = containerByFolder(localFolder);
  if (!c) {
    const p = projects.get(localFolder);
    toast(
      'Ask agent: the container is not running.',
      projectStarts && p && !p.starting
        ? { label: 'Start', run: () => startProject(localFolder) }
        : undefined,
    );
    return;
  }
  open?.close();
  const hasSelection = Boolean(context.selection?.text);
  const $question = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'task-text ask-question',
    rows: 5,
    'aria-label': 'Question',
    placeholder: 'Ask about this file…',
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      void ask();
    },
    oninput: () => {
      $error.textContent = '';
    },
  }));
  const $include = /** @type {HTMLInputElement} */ (h('input', {
    type: 'checkbox',
    checked: true,
  }));
  const $where = h('code', { class: 'ask-where' });
  const showWhere = () => {
    $where.textContent = askWhere(
      $include.checked ? context : { ...context, selection: undefined },
    ).replaceAll('`', '');
  };
  $include.addEventListener('change', showWhere);
  showWhere();
  // The target to keep picked as the list changes: the one last asked from this repo, until
  // another is picked (a past session is only offered once the sessions have loaded).
  let picked = savedTargets()[root];
  const $target = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'new-note-project ask-target',
    'aria-label': 'Agent',
    onchange: () => {
      picked = $target.value;
    },
  }));
  const $error = h('div', { class: 'new-note-error', role: 'alert' });
  const $ask = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void ask(),
  }, 'Ask'));
  /** @type {AskTarget[]} */
  let targets = [];
  let loading = true;
  let busy = false;

  /** Lists the targets in the picker, keeping the one picked while it is offered. */
  const fillTargets = () => {
    targets = askTargets(
      agentPanes(c, localFolder, root),
      lastSessions.get(c.id) ?? [],
      root,
      LABELS.agents,
    );
    const group = (label, kind) => {
      const of = targets.filter((t) => t.kind === kind);
      if (of.length === 0 && !(kind === 'session' && loading)) return null;
      return h(
        'optgroup',
        { label },
        ...of.map((t) =>
          h(
            'option',
            { value: t.key },
            kind === 'new'
              ? t.label
              : `${LABELS.agents[t.agent] ?? t.agent} · ${t.label}`,
          )
        ),
        ...(kind === 'session' && loading
          ? [h('option', { disabled: true }, 'Loading past sessions…')]
          : []),
      );
    };
    $target.replaceChildren(
      ...[
        group('Running', 'pane'),
        group('Past sessions', 'session'),
        group('New', 'new'),
      ].filter((g) => g !== null),
    );
    $target.value = defaultAskTarget(targets, picked)?.key ?? '';
  };

  const loadTargets = async () => {
    loading = true;
    fillTargets();
    try {
      lastSessions.set(
        c.id,
        parseSessions(await call({ type: 'list_sessions', container: c.id })),
      );
    } catch { /* the running agents and new sessions are still offered */ }
    loading = false;
    if (el.open) fillTargets();
  };

  const ask = async () => {
    if (busy) return;
    const question = $question.value.trim();
    if (question === '') {
      $error.textContent = 'Type a question first.';
      $question.focus();
      return;
    }
    const target = targets.find((t) => t.key === $target.value);
    if (!target) return;
    const text = askText(question, context, $include.checked);
    if (text.length > MAX_ASK_TEXT) {
      $error.textContent =
        `Too long: ${text.length} of ${MAX_ASK_TEXT} characters.`;
      return;
    }
    busy = true;
    $ask.disabled = true;
    $error.textContent = '';
    if (c.state === 'no-session') toast('Starting Herdr…');
    let result;
    try {
      result = await call({
        type: 'ask_agent',
        container: c.id,
        root,
        text,
        ...askTargetFields(target),
      });
    } catch (e) {
      busy = false;
      $ask.disabled = false;
      $error.textContent = `Ask failed: ${e?.message ?? e}`;
      // A session no longer listed (a restart, or another window listed since), or a terminal
      // gone: list again.
      if (e?.code === 'not_found') void loadTargets();
      return;
    }
    saveTarget(root, target.key);
    el.close();
    if (typeof result?.pane_id === 'string') {
      placePane(localFolder, result, { where: 'right', at });
    }
  };

  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note task-dialog ask-dialog',
      'aria-label': 'Ask agent',
      onclose: () => {
        if (open === el) open = null;
        el.remove();
      },
    },
    h('header', { class: 'dialog-header' }, h('span', {}, 'Ask agent')),
    h(
      'div',
      { class: 'new-note-body' },
      h(
        'div',
        { class: 'ask-about' },
        h('span', {}, 'About '),
        $where,
        hasSelection
          ? h('label', { class: 'ask-include' }, $include, 'Include selection')
          : '',
      ),
      $question,
      h('label', {}, 'Agent', $target),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        `${
          IS_MAC ? '⌘Enter' : 'Ctrl+Enter'
        } asks; the agent opens to the right`,
      ),
      h(
        'span',
        { class: 'task-buttons' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $ask,
      ),
    ),
  ));
  open = el;
  document.body.append(el);
  el.showModal();
  void loadTargets();
  $question.focus();
}
