// The corner toggle of a `/sidebar` or `/main` page devc-desktop lays out (`#…&sidebar=shown` or
// `hidden`), in the window's top-left corner as devc web's own page has it (`index.html`): over
// `/sidebar`'s header, it hides the app's left column; over `/main`'s top-left tile while the
// column is hidden, it shows it again. The app shows and hides the column. The button only asks,
// with a console line (`devc-desktop:sidebar hide` / `show`), as the page tells it of its dialogs
// (`client.js`), and the app says what it did by changing the hash, which reloads nothing.

import { h, svgIcon } from './ui.js';
import { desktopSidebarFromHash } from './lib/view.js';

/** @param {HTMLElement} $app  the page's `.app` */
export function mountSidebarCorner($app) {
  if (desktopSidebarFromHash(location.hash) === null) return;
  const hide = svgIcon('sidebarHide');
  hide.classList.add('icon-hide');
  const show = svgIcon('sidebarShow');
  show.classList.add('icon-show');
  const button = h(
    'button',
    {
      class: 'sidebar-toggle sidebar-corner',
      type: 'button',
      onclick: () => {
        const hidden = $app.dataset.sidebar === 'hidden';
        console.debug(`devc-desktop:sidebar ${hidden ? 'show' : 'hide'}`);
      },
    },
    hide,
    show,
  );
  const apply = () => {
    const state = desktopSidebarFromHash(location.hash) ?? 'shown';
    $app.dataset.sidebar = state;
    const label = state === 'hidden' ? 'Show sidebar' : 'Hide sidebar';
    button.setAttribute('aria-label', label);
    button.title = label;
  };
  apply();
  window.addEventListener('hashchange', apply);
  $app.append(button);
}
