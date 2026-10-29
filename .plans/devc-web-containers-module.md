# devc web: Containers as its own module, and menus that fit split views

Decided with the user on 2026-10-28. Third of six plans (see "Git and the trusted host area" in
`PLAN.md`). No user-visible change except the menu fixes. It prepares
`devc-desktop-containers-column`, which runs this module outside devc web's page.

## Checklist

- [ ] Menus: close on window `blur`; a menu taller than the viewport scrolls.
- [ ] `static/containers.js`: the Containers section moved out of `sidebar.js`.
- [ ] The In use ↔ Containers coupling goes through an explicit interface (below).
- [ ] `/containers` page: the section alone, as `/sidebar` and `/main` are.
- [ ] Tests, README.

## Goal

1. **Menus.** In a split layout a page is one of several views, and its menus must live inside it.
   - `ui.js`: `window.addEventListener('blur', closeMenu)`. A click in another view takes focus
     from this page and must close the menu, as a click here does (`ui.js` around line 616).
   - The menu's `max-height` is the viewport less 8px, with `overflow-y: auto`. Placement
     (`ui.js` around line 605) clamps `top` and `left` at `>= 4`. A menu taller than a short view
     no longer loses its head.
2. **Module.** The Containers section (everything under the Containers heading: container rows,
   repo cards drawn there, their file trees, panes, Past sessions, tasks, PR rows, Start/Stop/Remove,
   fold state) lives in `static/containers.js`. `sidebar.js` keeps In use, pinned files, Layout
   and the section frame.
3. **Page.** `/containers` (`containers.html`, `containers-page.js`) mounts only the module, paired
   with `/main` and `/sidebar` by view id, as `remote.js` pairs `/sidebar` with `/main`.

Since this plan was written (2026-10-29), the Containers section also holds the project rows'
location icons (`envKindMark`: a laptop for this machine, a cube for a container), **Remove
project**, **Start on this machine** / **Start in a container**, and the Add project picker's
"where it runs" choice. They move with the module like everything else in the section.

## Contracts

`static/containers.js`:

```js
/**
 * Mounts the Containers section in `root`.
 * @param {HTMLElement} root
 * @param {{
 *   tileArea: import('./lib/view.js').TileArea,   // open panes, files, diffs (as sidebar.js gets it)
 *   inUse: InUseLink,                             // the coupling below
 *   standalone: boolean,                          // true on /containers: draws its own heading
 * }} opts
 * @returns {{ reveal(ref): void, onViewState(state): void }}
 */
export function mountContainers(root, opts);
```

`InUseLink`, the whole coupling between the two halves. Today these are direct calls inside
`sidebar.js`; the names are the implementer's, the set is not:

- `revealInUse(key)`: Containers → In use (today's `revealInUse`, `sidebar.js` around line 1795).
- `inUseKeys(): Set<string>`: which repo cards In use shows, so Containers draws its stand-ins.
- `pin(key, pinned)`: Pin to In use / Unpin.
- `onInUseChange(cb)`: In use's set changed.
- In use → Containers: `reveal(ref)` (today's `revealInContainers`, line 1577) and the stand-in's
  fold state.

In the same page (`/`, `/sidebar`) the link is a direct object. Across pages it is relayed by the
server, as `lib/view.js` relays `view_intent` / `sidebar_intent`:

- `lib/view.js` gains `CONTAINERS_INTENT_NAMES = ['reveal', 'setFold']` and
  `INUSE_INTENT_NAMES = ['revealInUse', 'pin']`. Two new relayed message types,
  `containers_intent` and `inuse_intent`, with the same shape and validation as `sidebar_intent`
  (`protocol.ts`), routed by view id.
- `view_state` gains `inUse: string[]` (the keys), so `/containers` can draw stand-ins.

Fold and collapse state stays in `sidebarState` with its current keys, so nothing saved is lost.
`/containers` reads and writes the same keys.

## Concept boundaries

- "Containers" (the section) also lists host projects ("this machine"). Keep the name; the
  rename to "Projects" is out of scope.
- `remoteSidebar` / `remoteTileArea` (`remote.js`) are the `/main` ↔ `/sidebar` halves. Add the
  `/containers` halves beside them; don't overload the existing intents.

## Validation

- `cd devc && deno task test` passes. `lib/view.js` tests cover the new intent names and
  `view_state.inUse`. `protocol.ts` parse tests cover `containers_intent` and `inuse_intent`
  (valid, unknown name, bad view id).
- Manual on `/` (the whole page): no visible change. Reveal in Containers, Pin to In use, the
  stand-in's chevron, opening a pane from a container card, and Collapse all all behave as before.
- Manual with `/sidebar`, `/main` and `/containers` in three tabs with the same `view=`: the same
  actions work across tabs.
- Manual: open a menu in `/sidebar`, click in `/main`, and the menu closes. Shrink a window until
  a repo card's menu is taller than it: the menu scrolls, and its first item is visible.

## Relevant files

`devc/web/static/sidebar.js` (`repoCards`, `repoCard`, `containerCard`, `revealInContainers`,
`revealInUse`, `floorInUseSections`), `static/ui.js` (menu), `static/style.css`,
`static/lib/view.js`, `static/remote.js`, `static/sidebar-page.js`, `static/main-page.js`,
`devc/web/protocol.ts`, `devc/web/server.ts` (route table near line 397, relays),
`.plans/archived/devc-web-sidebar-main-routes.md` (the split-page design).
