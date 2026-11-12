// The New worktree and Delete worktree dialogs of a repo card (`cards.js`): see
// `.plans/devc-web-worktrees.md`. They only ask: the server (`git_worktree.ts`) checks everything
// again and does the work in the repo's environment, and what it reports stays in the dialog.

import { forceRemoveAllowed, nextId, onServerMessage, send } from './client.js';
import { branchChoices, folderNameFor, worktreeNote } from './lib/worktree.js';
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
 * **New worktree…** on a primary repo's card, or one of its worktrees' (`folder` is always the
 * primary's): in `<repo>.worktrees/<folder>`, from an open PR (**Pull request**) or a local or
 * origin branch (**Branch**). Branch defaults to the base's name; another name makes a new local
 * branch from it. The note says what Create will do (`worktreeNote`).
 *
 * @param {{localFolder: string, folder: string, repoName: string, onCreated: () => void}} o
 */
export function openNewWorktreeDialog(
  { localFolder, folder, repoName, onCreated },
) {
  const done = new AbortController();
  const repoBase = folder.split('/').pop() ?? repoName;
  /** @type {any} */
  let opts = null;
  /** @type {'pr' | 'branch'} */
  let tab = 'branch';
  /** @type {import('./lib/worktree.js').WorktreeBase | null} */
  let base = null;
  /** @type {import('./lib/worktree.js').BranchChoice[]} */
  let choices = [];
  let branchEdited = false;
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
  const $branch = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'new-note-project',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Branch',
    oninput: () => {
      branchEdited = true;
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
  // Each field's problem, under it: see `worktreeNote`'s `errors`.
  const fieldError = () =>
    h('div', { class: 'worktree-field-error', role: 'alert', hidden: true });
  const $baseError = fieldError();
  const $branchError = fieldError();
  const $folderError = fieldError();
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
    h('span', { class: 'spinner' }),
    'Loading…',
  );
  const $form = h(
    'div',
    { class: 'worktree-form', hidden: true },
    $tabs,
    h('div', { class: 'worktree-pick' }, $filter, $list, $baseError),
    h(
      'label',
      {},
      'Branch',
      $branch,
      $branchError,
    ),
    h(
      'label',
      {},
      'Folder',
      h(
        'span',
        { class: 'worktree-folder' },
        h('span', { class: 'worktree-prefix' }, `${repoBase}.worktrees/`),
        $name,
      ),
      $folderError,
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

  /**
   * Picks a base: Branch takes its name (a fork's PR: `pr-<n>`) unless the user has typed one.
   * @param {import('./lib/worktree.js').WorktreeBase} b
   */
  function pick(b) {
    base = b;
    if (!branchEdited) {
      $branch.value = b.kind === 'pr' ? b.head ?? `pr-${b.number}` : b.name;
      if (!nameEdited) $name.value = folderNameFor($branch.value);
    }
    renderList();
    update();
  }

  function renderTabs() {
    const button = (/** @type {typeof tab} */ t, /** @type {string} */ label) =>
      h('button', {
        type: 'button',
        'aria-pressed': String(tab === t),
        onclick: () => {
          if (tab === t) return;
          tab = t;
          base = null;
          $filter.value = '';
          renderTabs();
          renderList();
          update();
        },
      }, label);
    $tabs.replaceChildren(
      button('branch', 'Branch'),
      button('pr', 'Pull request'),
    );
  }

  /** @param {string} text */
  const empty = (text) => h('div', { class: 'worktree-empty' }, text);

  function renderList() {
    if (!opts) return;
    const q = $filter.value.trim().toLowerCase();
    if (tab === 'pr') {
      const prs = /** @type {any[]} */ (opts.prs).filter((p) =>
        q === '' || `#${p.number} ${p.title} ${p.author} ${p.headRefName}`
          .toLowerCase().includes(q)
      );
      $list.replaceChildren(
        ...(opts.prs.length === 0
          ? [empty(opts.prsProblem ?? 'No open pull requests')]
          : prs.map((p) =>
            h(
              'div',
              {
                class: 'worktree-item',
                role: 'option',
                'aria-selected': String(
                  base?.kind === 'pr' && base.number === p.number,
                ),
                title: p.headRefName,
                onclick: () =>
                  pick({
                    kind: 'pr',
                    number: p.number,
                    head: p.crossRepository ? null : p.headRefName,
                  }),
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
      return;
    }
    const shown = choices.filter((c) =>
      q === '' || c.label.toLowerCase().includes(q)
    );
    $list.replaceChildren(
      ...(choices.length === 0
        ? [empty(opts.remoteProblem ?? 'No branches')]
        : shown.slice(0, 500).map((c) =>
          h(
            'div',
            {
              class: 'worktree-item',
              role: 'option',
              'aria-selected': String(
                base?.kind === c.kind && base.name === c.name,
              ),
              onclick: () => pick({ kind: c.kind, name: c.name }),
            },
            h('span', { class: 'worktree-title' }, c.label),
            c.checkedOut
              ? h('span', { class: 'worktree-badge' }, 'checked out')
              : '',
            h(
              'span',
              { class: 'worktree-author' },
              c.kind === 'local' ? 'local' : 'origin',
            ),
          )
        )),
      ...(choices.length > 0 && opts.remoteProblem
        ? [empty(`origin: ${opts.remoteProblem}`)]
        : []),
    );
  }

  function update() {
    showError(null);
    if (!opts) return;
    const { errors, note, blocked } = worktreeNote({
      tab,
      base,
      branch: $branch.value.trim(),
      name: $name.value.trim(),
      localBranches: opts.localBranches,
      checkedOut: opts.checkedOut,
      folders: opts.folders,
    });
    $note.textContent = note;
    for (
      const [$err, text, $field] of /** @type {const} */ ([
        [$baseError, errors.base, null],
        [$branchError, errors.branch, $branch],
        [$folderError, errors.folder, $name],
      ])
    ) {
      $err.textContent = text ?? '';
      $err.hidden = !text;
      if ($field) {
        if (text) $field.setAttribute('aria-invalid', 'true');
        else $field.removeAttribute('aria-invalid');
      }
    }
    $create.disabled = busy || blocked;
  }

  async function create() {
    if (busy || !opts || base === null) return;
    const branch = $branch.value.trim();
    const name = $name.value.trim();
    const source = base.kind === 'pr'
      ? { kind: 'pr', number: base.number }
      : base.kind === 'remote'
      ? { kind: 'remote', remoteBranch: base.name }
      : { kind: 'local', base: base.name };
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
      toast(`created ${repoBase}.worktrees/${name} on ${r.branch}`);
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
      choices = branchChoices(opts);
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
