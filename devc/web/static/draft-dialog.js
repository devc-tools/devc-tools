// The Save dialog of a draft tile (`lib/drafts.js`): which running project, which of its repos and
// what path. It only asks: `submit` does the writing, and what it reports stays in the dialog so
// the path can be corrected.

import { notePathError } from './lib/pinned_files.js';
import { containerLabel } from './lib/sidebar.js';
import { suggestedDraftPath } from './lib/drafts.js';
import { containerByFolder, projectRepos, projects } from './client.js';
import { h } from './ui.js';

/**
 * Asks where a draft goes. `submit` returns why it could not be saved there (the dialog stays
 * open and shows it), `''` to stay open saying nothing, or `null` once saved (the dialog closes).
 *
 * @param {{name: string, near: {localFolder?: string | null, root?: string | null,
 *   path?: string | null}, submit: (dest: {localFolder: string, root: string, path: string}) =>
 *   Promise<string | null>}} opts
 * @returns {boolean} false when no project has a running container to save in
 */
export function openDraftSaveDialog({ name, near, submit }) {
  const running = [...projects.values()]
    .filter((p) => containerByFolder(p.localFolder)?.state === 'connected')
    .sort((a, b) => a.name.localeCompare(b.name));
  if (running.length === 0) return false;
  const initial = running.find((p) => p.localFolder === near.localFolder) ??
    running[0];

  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => fillRepos(),
    },
    ...running.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $repo = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'new-note-project',
    'aria-label': 'Repo',
  }));
  const $repoLabel = h('label', {}, 'Repo', $repo);
  const $path = /** @type {HTMLInputElement} */ (h('input', {
    type: 'text',
    class: 'picker-path',
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Path in the repo',
    oninput: () => showError(null),
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      void save();
    },
  }));
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $save = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void save(),
  }, 'Save'));
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note',
      'aria-label': `Save ${name}`,
      onclose: () => el.remove(),
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, `Save ${name}`),
      h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      h('label', {}, 'Project', $project),
      $repoLabel,
      h('label', {}, 'File, in the repo', $path),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h('span', { class: 'picker-hint' }, 'Its folder must exist'),
      $save,
    ),
  ));

  /** The selected project's repos; a project with none saves in its own folder. */
  function fillRepos() {
    const repos = projectRepos($project.value);
    $repo.replaceChildren(
      ...repos.map((r) =>
        h(
          'option',
          { value: r.folder, selected: r.folder === near.root },
          r.name,
        )
      ),
    );
    $repoLabel.hidden = repos.length < 2;
  }

  /** @param {string | null} message */
  function showError(message) {
    $error.textContent = message ?? '';
    $error.hidden = message === null;
  }

  let busy = false;
  async function save() {
    if (busy) return;
    const path = $path.value.trim();
    const invalid = notePathError(path);
    if (invalid !== null) {
      showError(invalid);
      return;
    }
    busy = true;
    $save.disabled = true;
    showError(null);
    const localFolder = $project.value;
    let problem;
    try {
      problem = await submit({
        localFolder,
        root: $repo.value || localFolder,
        path,
      });
    } catch (e) {
      problem = String(/** @type {Error} */ (e)?.message ?? e);
    }
    busy = false;
    $save.disabled = false;
    if (problem === null) el.close();
    else if (problem !== '') showError(problem);
  }

  fillRepos();
  $path.value = suggestedDraftPath(
    name,
    $project.value === near.localFolder && $repo.value === near.root
      ? near.path
      : null,
  );
  document.body.append(el);
  el.showModal();
  $path.focus();
  // The name alone, ready to retype, as a desktop's Save As selects it.
  $path.setSelectionRange($path.value.length - name.length, $path.value.length);
  return true;
}
