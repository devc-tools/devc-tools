// The `devc web` task dialog: a new task or an edited one, its route (a project and one of its
// repos) and the agent it goes to, saved (`add_task` / `update_task`) and maybe sent
// (`send_task`). The Tasks section (`sidebar.js`) opens it, and so does a repo card's or a
// folder's **New task here** (`cards.js`), wherever the card is drawn. It reaches the page only
// through what `setTaskContext` was given.

import { byName, containerLabel } from './lib/sidebar.js';
import {
  parseTaskDefault,
  savedTaskAgent,
  TASK_AGENT_IDS,
  taskTitle,
} from './lib/tasks.js';
import { emptyViewState, focusedTile } from './lib/view.js';
import { h, iconButton, LABELS, toast } from './ui.js';
import {
  basename,
  call,
  containerByFolder,
  projectRepos,
  projects,
  projectStarts,
} from './client.js';
import { placePane, startProject } from './menus.js';

/** @typedef {import('./lib/view.js').TileArea} TileArea */

/**
 * What the dialog reaches on its page: the tiling area (a new task is routed to its focused tile's
 * project), what renders again once the pinned default changes, and what a task sent does (the
 * Tasks section folds).
 */
const context = {
  tileArea: /** @type {TileArea | null} */ (null),
  changed: () => {},
  sent: () => {},
};

/**
 * Sets what the dialog reaches on its page (see {@link context}): each part given replaces it.
 *
 * @param {{tileArea?: TileArea, changed?: () => void, sent?: () => void}} parts
 */
export function setTaskContext(parts) {
  Object.assign(context, parts);
}

/** The agent the task dialog last sent to. */
const TASK_AGENT_KEY = 'devc-web-task-agent-v1';
/** The default route and agent for new tasks, pinned in the task dialog. */
const TASK_DEFAULT_KEY = 'devc-web-task-default-v1';

/** The agent the task dialog last sent to, as stored; `null` when there is none. */
function storedTaskAgent() {
  try {
    return localStorage.getItem(TASK_AGENT_KEY);
  } catch {
    return null;
  }
}

/** The default for new tasks pinned in the task dialog; `null` when there is none. */
function storedTaskDefault() {
  try {
    return parseTaskDefault(localStorage.getItem(TASK_DEFAULT_KEY));
  } catch {
    return null;
  }
}

/**
 * Pins `value` as the default for new tasks, or clears it with `null`.
 *
 * @param {import('./lib/tasks.js').TaskDefault | null} value
 */
function storeTaskDefault(value) {
  try {
    if (value === null) localStorage.removeItem(TASK_DEFAULT_KEY);
    else localStorage.setItem(TASK_DEFAULT_KEY, JSON.stringify(value));
  } catch { /* storage unavailable */ }
}

/** The agent a task starts on: the pinned default's, else the last one sent to, else Claude. */
export function taskSendAgent() {
  return storedTaskDefault()?.agent ?? savedTaskAgent(storedTaskAgent());
}

/** A new task routed to folder root `fr`'s project and repo. */
export function newTaskIn(fr) {
  openTaskDialog(undefined, { localFolder: fr.localFolder, root: fr.root });
}

/** "`what`: the container is not running", offering to start it. */
export function notRunningToast(localFolder, what) {
  const p = projects.get(localFolder);
  toast(
    `${what}: the container is not running.`,
    projectStarts && p && !p.starting
      ? { label: 'Start', run: () => startProject(localFolder) }
      : undefined,
  );
}

/**
 * The open task dialog. `taskId` is the task being edited, or set once a new one is saved.
 *
 * @type {{el: HTMLDialogElement, $text: HTMLTextAreaElement, $project: HTMLSelectElement,
 *   $repo: HTMLSelectElement, $repoLabel: HTMLElement, $agent: HTMLSelectElement,
 *   $error: HTMLElement, $buttons: HTMLButtonElement[], $send: HTMLButtonElement[],
 *   taskId: string | null, busy: boolean} | null}
 */
let taskDialog = null;

/** Closes the task dialog, if it is open. */
export function closeTaskDialog() {
  taskDialog?.el.close();
}

/**
 * The task dialog, for a new task or `task`: its text, its route (a project and one of its repos,
 * or none) and an agent. **Save** keeps it on the list; the header's **Send: plan** /
 * **Send: implement** icons save it, then send it (`send_task`) and show the agent's pane.
 *
 * A new task opens routed to `route` when it is given, else to the pinned default's route, else
 * (with no default pinned) to the focused tile's project. The header row's pin makes the
 * dialog's project, repo and agent the default for new tasks, or clears it.
 *
 * @param {import('./lib/tasks.js').Task} [task]
 * @param {{localFolder: string, root: string}} [route]
 */
export function openTaskDialog(task, route) {
  taskDialog?.el.close();
  const candidates = [...projects.values()].sort(byName);
  const pinned = storedTaskDefault();
  const pinnedRoute = pinned?.localFolder !== undefined &&
      projects.has(pinned.localFolder)
    ? { localFolder: pinned.localFolder, root: pinned.root ?? null }
    : null;
  const focused = focusedTile(context.tileArea?.state() ?? emptyViewState());
  // A default pinned without a route means "not routed": the focused tile does not count.
  const pinnedUnrouted = pinned !== null && pinned.localFolder === undefined;
  const near = route?.localFolder ?? pinnedRoute?.localFolder ??
    (pinnedUnrouted
      ? undefined
      : focused?.ref?.localFolder ?? focused?.file?.localFolder);
  const initial = task
    ? task.localFolder ?? ''
    : near && projects.has(near)
    ? near
    : '';
  const initialRoot = task ? task.root ?? null : route?.root ??
    (initial === pinnedRoute?.localFolder ? pinnedRoute.root : null);
  const $text = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'task-text',
    spellcheck: 'true',
    rows: 8,
    'aria-label': 'Task',
    placeholder: 'What should be done? The first line is its title.',
    oninput: () => showTaskError(null),
    onkeydown: (e) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      void submitTask(null);
    },
  }));
  $text.value = task?.text ?? '';
  const $project = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Project',
      onchange: () => {
        fillTaskRepos(null);
        showPinned();
      },
    },
    h('option', { value: '', selected: initial === '' }, '(not routed)'),
    ...candidates.map((p) =>
      h(
        'option',
        { value: p.localFolder, selected: p.localFolder === initial },
        containerLabel(p, projects.values()),
      )
    ),
  ));
  const $repo = /** @type {HTMLSelectElement} */ (h('select', {
    class: 'new-note-project',
    'aria-label': 'Repo',
    onchange: () => showPinned(),
  }));
  const $repoLabel = h('label', {}, 'Repo', $repo);
  const $agent = /** @type {HTMLSelectElement} */ (h(
    'select',
    {
      class: 'new-note-project',
      'aria-label': 'Agent',
      onchange: () => {
        titleSends();
        showPinned();
      },
    },
    ...TASK_AGENT_IDS.map((id) =>
      h('option', { value: id }, LABELS.agents[id])
    ),
  ));
  $agent.value = taskSendAgent();
  const $error = h('div', { class: 'new-note-error', hidden: true });
  const $save = /** @type {HTMLButtonElement} */ (h('button', {
    type: 'button',
    class: 'primary',
    onclick: () => void submitTask(null),
  }, 'Save'));
  /** @type {['plan', 'implement']} */
  const actions = ['plan', 'implement'];
  const $send = actions.map((
    action,
  ) => /** @type {HTMLButtonElement} */ (iconButton(
    action,
    '',
    () => void submitTask(action),
  )));
  // The icons name the agent they send to, so they follow the Agent dropdown.
  const titleSends = () => {
    const agentLabel = LABELS.agents[$agent.value];
    $send.forEach(($b, i) => {
      const title = `Send to ${agentLabel}: ${actions[i]}`;
      $b.title = title;
      $b.setAttribute('aria-label', title);
    });
  };
  titleSends();
  // The dialog's project, repo and agent, as a default for new tasks would store them.
  const current = () =>
    $project.value === '' ? { agent: /** @type {any} */ ($agent.value) } : {
      localFolder: $project.value,
      root: $repo.value,
      agent: /** @type {any} */ ($agent.value),
    };
  const isPinned = () => {
    const saved = storedTaskDefault();
    const now = current();
    return saved !== null && saved.agent === now.agent &&
      saved.localFolder === now.localFolder && saved.root === now.root;
  };
  const $pin = /** @type {HTMLButtonElement} */ (iconButton('pin', '', () => {
    storeTaskDefault(isPinned() ? null : current());
    showPinned();
    context.changed();
  }));
  // The pin is pressed while the dialog shows the pinned default.
  const showPinned = () => {
    const on = isPinned();
    const title = on ? LABELS.unpinTaskDefault : LABELS.pinTaskDefault;
    $pin.setAttribute('aria-pressed', String(on));
    $pin.title = title;
    $pin.setAttribute('aria-label', title);
  };
  const el = /** @type {HTMLDialogElement} */ (h(
    'dialog',
    {
      class: 'dialog new-note task-dialog',
      'aria-label': task ? 'Task' : 'New task',
      onclose: () => {
        if (taskDialog?.el === el) taskDialog = null;
        el.remove();
      },
    },
    h(
      'header',
      { class: 'dialog-header' },
      h('span', {}, task ? 'Task' : 'New task'),
      h('span', { class: 'task-send' }, ...$send),
    ),
    h(
      'div',
      { class: 'new-note-body' },
      $text,
      h(
        'div',
        { class: 'task-route' },
        h('label', {}, 'Project', $project),
        $repoLabel,
        h('label', {}, 'Agent', $agent),
        $pin,
      ),
      $error,
    ),
    h(
      'footer',
      { class: 'dialog-footer' },
      h(
        'span',
        { class: 'picker-hint' },
        'Sending starts the agent in the repo',
      ),
      h(
        'span',
        { class: 'task-buttons' },
        h('button', { type: 'button', onclick: () => el.close() }, 'Cancel'),
        $save,
      ),
    ),
  ));
  taskDialog = {
    el,
    $text,
    $project,
    $repo,
    $repoLabel,
    $agent,
    $error,
    $buttons: [$save, ...$send, $pin],
    $send,
    taskId: task?.id ?? null,
    busy: false,
  };
  document.body.append(el);
  el.showModal();
  fillTaskRepos(initialRoot);
  showPinned();
  $text.focus();
}

/**
 * Lists the selected project's repos (selecting `root` when it is one of them), hides the Repo
 * field when there is no choice, and enables Send only for a routed task.
 */
function fillTaskRepos(root) {
  const td = taskDialog;
  if (!td) return;
  const localFolder = td.$project.value;
  const repos = localFolder === ''
    ? []
    : projectRepos(localFolder).filter((r, i) => i === 0 || r.git !== null);
  if (localFolder !== '' && repos.length === 0) {
    repos.push({ folder: localFolder });
  }
  td.$repo.replaceChildren(
    ...repos.map((r) =>
      h(
        'option',
        { value: r.folder, title: r.folder, selected: r.folder === root },
        r.name ?? basename(r.folder),
      )
    ),
  );
  if (root !== null && repos.some((r) => r.folder === root)) {
    td.$repo.value = root;
  }
  td.$repoLabel.hidden = repos.length < 2;
  for (const b of td.$send) b.disabled = td.busy || localFolder === '';
  showTaskError(null);
}

/** Shows `message` under the task dialog's fields, or hides it with `null`. */
function showTaskError(message) {
  if (!taskDialog) return;
  taskDialog.$error.textContent = message ?? '';
  taskDialog.$error.hidden = message === null;
}

/**
 * Saves the dialog's task (`add_task` or `update_task`), then with `action` sends it
 * (`send_task`), folds the Tasks section, and shows the agent's pane in the focused stack. A
 * failure keeps the dialog open with the error; a task saved before a failed send stays saved,
 * and stays on the list.
 *
 * @param {'plan' | 'implement' | null} action
 */
async function submitTask(action) {
  const td = taskDialog;
  if (!td || td.busy) return;
  const text = td.$text.value.trim();
  if (text === '') {
    showTaskError('Write the task first');
    return;
  }
  const localFolder = td.$project.value;
  const root = td.$repo.value;
  const route = localFolder !== '' && root !== '' ? { localFolder, root } : {};
  if (action !== null && !('localFolder' in route)) {
    showTaskError('Choose a project to send it to');
    return;
  }
  if (action !== null && !containerByFolder(localFolder)) {
    showTaskError('The container is not running: start it first');
    notRunningToast(localFolder, taskTitle(text));
    return;
  }
  const busy = (on) => {
    td.busy = on;
    for (const b of td.$buttons) b.disabled = on;
    if (!on) fillTaskRepos(td.$repo.value);
  };
  busy(true);
  try {
    if (td.taskId === null) {
      td.taskId = (await call({ type: 'add_task', text, ...route }))?.task ??
        null;
    } else {
      await call({ type: 'update_task', task: td.taskId, text, ...route });
    }
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  if (action === null || td.taskId === null) {
    td.el.close();
    return;
  }
  const agent = td.$agent.value;
  try {
    localStorage.setItem(TASK_AGENT_KEY, agent);
  } catch { /* storage unavailable */ }
  const c = containerByFolder(localFolder);
  if (c?.state === 'no-session') toast('Starting Herdr…');
  let result;
  try {
    result = await call({
      type: 'send_task',
      task: td.taskId,
      localFolder,
      root,
      agent,
      action,
    });
  } catch (e) {
    busy(false);
    showTaskError(String(e?.message ?? e));
    return;
  }
  td.el.close();
  context.sent();
  if (typeof result?.pane_id === 'string') placePane(localFolder, result);
}
