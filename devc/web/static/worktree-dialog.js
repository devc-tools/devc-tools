// The New worktree and Delete worktree dialogs of a repo card (`cards.js`): see
// `.plans/devc-web-worktrees.md`. They only ask: the server (`git_worktree.ts`) checks everything
// again and does the work in the repo's environment, and what it reports stays in the dialog.

import { forceRemoveAllowed, nextId, onServerMessage, send } from './client.js';
import { folderNameFor, worktreeNote } from './lib/worktree.js';
import { h, toast } from './ui.js';

/**
 * Sends `msg` with a fresh id and resolves with its `reply` (or a refusal `result`, as
 * `{ok: false, problem}`). Rejects when the dialog is gone first (`signal`).
 *
 * @param {Record<string, unknown> & {type: string}} msg
 * @param {string} reply
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
function ask(msg, reply, signal) {
  const id = nextId('w');
  return new Promise((resolve, reject) => {
    const stop = onServerMessage((m) => {
      if (m?.id !== id) return;
      if (m.type === reply) {
        stop();
        resolve(m);
      } else if (m.type === 'result') {
        stop();
        resolve({ ok: false, problem: String(m.error?.message ?? 'refused') });
      }
    });
    signal.addEventListener('abort', () => {
      stop();
      reject(new Error('closed'));
    });
    send({ ...msg, id });
  });
}

/** A dialog shell: header with Cancel, body, footer. */
function shell(/** @type {string} */ title, body, footer) {
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note worktree-dialog',
      'aria-label': title,
      onclose: () => el.remove(),
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, title),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h('div', { class: 'new-note-body' }, ...body),
    h('footer', { class: 'dialog-footer' }, ...footer),
  ));
  return el;
}

/**
 * **New worktree…** on a primary repo's card: from an open PR, a branch on `origin`, or a new
 * branch, in `<repo>.worktrees/<folder>`.
 *
 * @param {{localFolder: string, folder: string, repoName: string,
 *   onCreated: () => void}} o
 */
export function openNewWorktreeDialog(
  { localFolder, folder, repoName, onCreated },
) {
  const done = new AbortController();
  const base = folder.split('/').pop() ?? repoName;
  /** @type {any} */
  let opts = null;
  /** @type {'pr' | 'remote' | 'new'} */
  let kind = 'pr';
  /** @type {number | null} */
  let prNumber = null;
  /** @type {string | null} */
  let remoteBranch = null;
  let nameEdited = false;
  let busy = false;

  const $tabs = h('div', { class: 'worktree-tabs', role: 'group' });
  const $filter = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-note-project',
    placeholder: 'Filter',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Filter',
    oninput: () => renderList(),
  }));
  const $list = h('div', { class: 'worktree-list', role: 'listbox' });
  const $pick = h('div', { class: 'worktree-pick' }, $filter, $list);
  const $baseDefault = /** @type {HTMLInputElement} */ (h('input', {
    type: 'radio',
    name: 'worktree-base',
    value: 'default',
    onchange: () => update(),
  }));
  const $baseCurrent = /** @type {HTMLInputElement} */ (h('input', {
    type: 'radio',
    name: 'worktree-base',
    value: 'current',
    onchange: () => update(),
  }));
  const $baseDefaultLabel = h(
    'label',
    { class: 'worktree-radio' },
    $baseDefault,
  );
  const $baseCurrentLabel = h(
    'label',
    { class: 'worktree-radio' },
    $baseCurrent,
  );
  const $base = h(
    'div',
    { class: 'worktree-base' },
    h('span', {}, 'Base'),
    $baseDefaultLabel,
    $baseCurrentLabel,
  );
  const $branch = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-note-project',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Branch',
    oninput: () => {
      if (!nameEdited) $name.value = folderNameFor($branch.value.trim());
      update();
    },
    onkeydown: enterCreates,
  }));
  const $name = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-note-project',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Folder',
    oninput: () => {
      nameEdited = true;
      update();
    },
    onkeydown: enterCreates,
  }));
  const $note = h('div', { class: 'picker-hint worktree-note' });
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $create = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    disabled: true,
    onclick: () => void create(),
  }, 'Create'));
  const $status = h(
    'span',
    { class: 'picker-hint' },
    h('span', {
      class: 'spinner',
    }),
    'Loading…',
  );
  const $form = h(
    'div',
    { class: 'worktree-form', hidden: true },
    $tabs,
    $pick,
    $base,
    h('label', {}, 'Branch', $branch),
    h(
      'label',
      {},
      'Folder',
      h(
        'span',
        { class: 'worktree-folder' },
        h('span', { class: 'worktree-prefix' }, `${base}.worktrees/`),
        $name,
      ),
    ),
    $note,
  );
  const el = shell(`New worktree of ${repoName}`, [$form, $error], [
    $status,
    $create,
  ]);
  el.addEventListener('close', () => done.abort());

  /** @param {KeyboardEvent} e */
  function enterCreates(e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!$create.disabled) void create();
  }

  /** @param {string | null} message */
  function showError(message) {
    $error.textContent = message ?? '';
    $error.hidden = message === null;
  }

  /** @param {string} branch */
  function setBranch(branch) {
    $branch.value = branch;
    if (!nameEdited) $name.value = folderNameFor(branch);
  }

  function renderTabs() {
    const tab = (/** @type {typeof kind} */ k, /** @type {string} */ label) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(kind === k),
        onclick: () => {
          if (kind === k) return;
          kind = k;
          prNumber = null;
          remoteBranch = null;
          $filter.value = '';
          if (k === 'new') setBranch('');
          renderTabs();
          renderList();
          update();
        },
      }, label);
    $tabs.replaceChildren(
      tab('pr', 'Pull request'),
      tab('remote', 'Remote branch'),
      tab('new', 'New branch'),
    );
    $pick.hidden = kind === 'new';
    $base.hidden = kind !== 'new';
  }

  function renderList() {
    if (!opts || kind === 'new') return;
    const q = $filter.value.trim().toLowerCase();
    if (kind === 'pr') {
      const prs = /** @type {any[]} */ (opts.prs).filter((p) =>
        q === '' || `#${p.number} ${p.title} ${p.author} ${p.headRefName}`
          .toLowerCase().includes(q)
      );
      $list.replaceChildren(
        ...(opts.prs.length === 0
          ? [
            h(
              'div',
              { class: 'worktree-empty' },
              opts.prsProblem ?? 'No open pull requests',
            ),
          ]
          : prs.map((p) =>
            h(
              'div',
              {
                class: 'worktree-item',
                role: 'option',
                'aria-selected': String(prNumber === p.number),
                title: p.headRefName,
                onclick: () => {
                  prNumber = p.number;
                  setBranch(
                    p.crossRepository ? `pr-${p.number}` : p.headRefName,
                  );
                  renderList();
                  update();
                },
              },
              h('span', { class: 'worktree-num' }, `#${p.number}`),
              h('span', { class: 'worktree-title' }, p.title),
              p.draft ? h('span', { class: 'worktree-badge' }, 'draft') : '',
              p.crossRepository
                ? h('span', { class: 'worktree-badge' }, 'fork')
                : '',
              h('span', { class: 'worktree-author' }, p.author),
            )
          )),
      );
    } else {
      const branches = /** @type {string[]} */ (opts.remoteBranches)
        .filter((b) => q === '' || b.toLowerCase().includes(q));
      $list.replaceChildren(
        ...(opts.remoteBranches.length === 0
          ? [
            h(
              'div',
              { class: 'worktree-empty' },
              opts.remoteProblem ?? 'No branches on origin',
            ),
          ]
          : branches.slice(0, 500).map((b) =>
            h('div', {
              class: 'worktree-item',
              role: 'option',
              'aria-selected': String(remoteBranch === b),
              onclick: () => {
                remoteBranch = b;
                setBranch(b);
                renderList();
                update();
              },
            }, h('span', { class: 'worktree-title' }, b))
          )),
      );
    }
  }

  function update() {
    showError(null);
    if (!opts) return;
    const branch = $branch.value.trim();
    const name = $name.value.trim();
    const { note, blocked } = worktreeNote({
      kind,
      branch,
      name,
      localBranches: opts.localBranches,
      checkedOut: opts.checkedOut,
      folders: opts.folders,
    });
    $note.textContent = note;
    const picked = kind === 'pr'
      ? prNumber !== null
      : kind === 'remote'
      ? remoteBranch !== null
      : $baseDefault.checked || $baseCurrent.checked;
    $create.disabled = busy || blocked || !picked;
  }

  async function create() {
    if (busy || !opts) return;
    const branch = $branch.value.trim();
    const name = $name.value.trim();
    const source = kind === 'pr'
      ? { kind, number: prNumber }
      : kind === 'remote'
      ? { kind, remoteBranch }
      : { kind, base: $baseDefault.checked ? 'default' : 'current' };
    busy = true;
    $create.disabled = true;
    $status.replaceChildren(h('span', { class: 'spinner' }), 'Creating…');
    $status.hidden = false;
    /** @type {any} */
    let r;
    try {
      r = await ask(
        { type: 'worktree_create', localFolder, folder, name, branch, source },
        'worktree_create_result',
        done.signal,
      );
    } catch {
      return;
    }
    busy = false;
    $status.hidden = true;
    if (r.ok) {
      el.close();
      toast(`created ${base}.worktrees/${name} on ${r.branch}`);
      onCreated();
      return;
    }
    update();
    showError(String(r.problem ?? 'failed'));
  }

  document.body.append(el);
  el.showModal();
  ask(
    { type: 'worktree_options', localFolder, folder },
    'worktree_options_result',
    done.signal,
  )
    .then((r) => {
      if (!r.ok) {
        $status.hidden = true;
        showError(String(r.problem ?? 'failed'));
        return;
      }
      opts = r;
      kind = opts.prs.length > 0 ? 'pr' : 'remote';
      $baseDefaultLabel.append(`origin/${opts.defaultBranch ?? ''}`);
      $baseCurrentLabel.append(`${opts.currentBranch ?? ''} (current)`);
      $baseDefaultLabel.hidden = opts.defaultBranch === null;
      $baseCurrentLabel.hidden = opts.currentBranch === null;
      if (opts.defaultBranch !== null) $baseDefault.checked = true;
      else if (opts.currentBranch !== null) $baseCurrent.checked = true;
      $status.hidden = true;
      $form.hidden = false;
      renderTabs();
      renderList();
      update();
      $filter.focus();
    }, () => {});
}

/**
 * **Delete worktree…** on a linked worktree's card: `git worktree remove` in its environment;
 * the branch stays. With uncommitted changes (`dirty`, from the card's ● count or the server's
 * answer), Delete needs **Discard N uncommitted changes** ticked, which a page under `--live`
 * may not offer.
 *
 * @param {{localFolder: string, folder: string, label: string, branch: string | null,
 *   dirty: number}} o
 */
export function openDeleteWorktreeDialog(
  { localFolder, folder, label, branch, dirty },
) {
  const done = new AbortController();
  let busy = false;
  let changes = dirty;
  const $discard = /** @type {HTMLInputElement} */ (h('input', {
    type: 'checkbox',
    onchange: () => update(),
  }));
  const $discardText = h('span', {});
  const $discardLabel = h(
    'label',
    { class: 'worktree-radio', hidden: true },
    $discard,
    $discardText,
  );
  const $refusedForce = h(
    'div',
    { class: 'picker-hint', hidden: true },
    'Commit or discard them first (not allowed under --live)',
  );
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $status = h(
    'span',
    { class: 'picker-hint', hidden: true },
    h('span', {
      class: 'spinner',
    }),
    'Deleting…',
  );
  const $delete = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary danger',
    onclick: () => void remove(),
  }, 'Delete'));
  const el = shell(`Delete worktree ${label}`, [
    h(
      'div',
      {},
      `Delete ${label}? The folder is removed; `,
      branch ? `branch ${branch} stays.` : 'its branch stays.',
    ),
    $discardLabel,
    $refusedForce,
    $error,
  ], [$status, $delete]);
  el.addEventListener('close', () => done.abort());

  function update() {
    const dirtyNow = changes > 0;
    $discardText.textContent = changes === Infinity
      ? 'Discard its uncommitted changes'
      : `Discard ${changes} uncommitted ${
        changes === 1 ? 'change' : 'changes'
      }`;
    $discardLabel.hidden = !dirtyNow || !forceRemoveAllowed;
    $refusedForce.hidden = !dirtyNow || forceRemoveAllowed;
    $delete.disabled = busy ||
      (dirtyNow && (!forceRemoveAllowed || !$discard.checked));
  }

  async function remove() {
    if (busy) return;
    busy = true;
    $error.hidden = true;
    $status.hidden = false;
    update();
    /** @type {any} */
    let r;
    try {
      r = await ask(
        {
          type: 'worktree_remove',
          localFolder,
          folder,
          force: changes > 0 && $discard.checked,
        },
        'worktree_remove_result',
        done.signal,
      );
    } catch {
      return;
    }
    busy = false;
    $status.hidden = true;
    if (r.ok) {
      el.close();
      toast(`deleted ${label}`);
      return;
    }
    // Changes the card hadn't counted yet: ask for the tick now.
    if (r.dirty && changes === 0) changes = Infinity;
    $error.textContent = String(r.problem ?? 'failed');
    $error.hidden = false;
    update();
  }

  update();
  document.body.append(el);
  el.showModal();
}
