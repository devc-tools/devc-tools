// The `devc web` boot guard: a classic script loaded before `app.js`. Until `app.js` calls
// `window.__devcBooted()` (the page has rendered its first `containers`), an uncaught error, a
// failed script load or 5 s without booting shows an overlay with Reload and Load last good
// (`/safe/`, the last page a browser rendered). After boot it does nothing: errors go to toasts.
//
// Self-contained on purpose: no imports, no style.css (inline styles only), so a broken page
// edit cannot also break the way out of it. Edit this file on its own, never together with
// other page files.

(function () {
  'use strict';
  var BOOT_TIMEOUT_MS = 5000;
  var safe = location.pathname.indexOf('/safe/') === 0;
  var booted = false;
  var shown = null;

  function show(message) {
    if (booted || shown) return;
    var overlay = document.createElement('div');
    shown = overlay;
    overlay.setAttribute('role', 'alertdialog');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;' +
      'display:flex;align-items:center;justify-content:center;' +
      'background:rgba(8,9,12,0.92);color:#d7dae0;' +
      'font:14px/1.5 system-ui,sans-serif;';
    var box = document.createElement('div');
    box.style.cssText = 'max-width:640px;padding:20px 24px;border-radius:8px;' +
      'background:#161922;border:1px solid #ff6b6b;';
    var title = document.createElement('div');
    title.textContent = safe
      ? 'The last good devc web UI failed to start'
      : 'devc web failed to start';
    title.style.cssText = 'font-weight:600;font-size:16px;margin-bottom:8px;';
    var detail = document.createElement('pre');
    detail.textContent = message;
    detail.style.cssText = 'white-space:pre-wrap;word-break:break-word;' +
      'margin:0 0 16px;color:#ffb3b3;font:12px/1.4 ui-monospace,monospace;' +
      'max-height:40vh;overflow:auto;';
    var buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:8px;';
    buttons.appendChild(button('Reload', function () {
      location.reload();
    }));
    if (!safe) {
      buttons.appendChild(button('Load last good', function () {
        // The same page, last good: `/sidebar` → `/safe/sidebar`, `/` → `/safe/`.
        location.href = '/safe' + location.pathname + location.search +
          location.hash;
      }));
    }
    box.appendChild(title);
    box.appendChild(detail);
    box.appendChild(buttons);
    overlay.appendChild(box);
    (document.body || document.documentElement).appendChild(overlay);
  }

  function button(label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = 'padding:6px 14px;border-radius:4px;cursor:pointer;' +
      'background:#1d212c;color:#d7dae0;border:1px solid #2a2f3c;font:inherit;';
    b.addEventListener('click', onClick);
    return b;
  }

  // Capture phase: a <script> or <link> that fails to load fires `error` on the element, which
  // does not bubble to window.
  window.addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      show('Failed to load ' + (t.src || t.href));
      return;
    }
    var where = ev.filename
      ? '\n  at ' + ev.filename + ':' + ev.lineno + ':' + ev.colno
      : '';
    show(String(ev.message || ev.error || 'Unknown error') + where);
  }, true);
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    show('Unhandled rejection: ' + (r && r.stack ? r.stack : String(r)));
  });

  var timer = setTimeout(function () {
    show(
      'The page did not finish starting within ' + BOOT_TIMEOUT_MS / 1000 +
        ' s.',
    );
  }, BOOT_TIMEOUT_MS);

  window.__devcBooted = function () {
    booted = true;
    clearTimeout(timer);
    if (shown) {
      shown.remove();
      shown = null;
    }
  };
})();
