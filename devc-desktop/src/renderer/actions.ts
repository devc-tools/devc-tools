// An Actions column: the cards of the host actions the app worked out (`actionCard` in
// `policy.ts`), each with its confirm. The HOST drawer shows the ones devc web's page asked for,
// the Containers pane the ones its own clicks asked for. Text only: nothing in a card is markup.
// A card's confirm button is disabled until ARM_MS after its content last changed, and a click
// counts only when the press began after that, so a click already in motion when the card
// appeared or changed never lands. The main process checks the arming again.

import { type ActionCard, ARM_MS } from '../main/policy.ts';

interface Shown {
  sig: string;
  el: HTMLElement;
  lines: HTMLElement;
  armedAt: number;
  pressedAt: number;
}

function el(
  tag: string,
  cls: string,
  text = '',
  children: Node[] = [],
): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  e.append(...children);
  return e;
}

const PHASE_TEXT: Partial<Record<ActionCard['phase'], string>> = {
  checking: 'Checking…',
  planning: 'Working out what would be pushed…',
  running: 'Running…',
};

/**
 * Draws cards into `column` (hidden while there are none). `show` takes the main process's list
 * and says how many cards it shows and how many still wait (not done); `progress` adds a line of
 * a running card's output.
 */
export function actionColumn(
  column: HTMLElement,
  act: { confirm(id: string): void; dismiss(id: string): void },
): {
  show(raw: unknown): { shown: number; waiting: number };
  progress(id: string, line: string): void;
} {
  const shown = new Map<string, Shown>();

  function cardEl(card: ActionCard, s: Shown): HTMLElement {
    const parts: Node[] = [
      el('div', 'title', card.title),
      el('div', 'folder', card.folder),
    ];
    const p = card.plan;
    if (p !== null) {
      parts.push(
        el('div', 'mono', `${p.branch} → ${p.remote}`),
        el('div', 'mono muted', `tip ${p.sha}`),
      );
      const list = el(
        'ul',
        '',
        '',
        p.commits.map((c) =>
          el('li', '', '', [
            el('span', 'mono', `${c.sha} `),
            document.createTextNode(c.subject),
            el('span', 'muted', ` — ${c.author}`),
          ])
        ),
      );
      if (p.more > 0) list.append(el('li', 'muted', `and ${p.more} more`));
      if (p.commits.length > 0) parts.push(list);
    }
    for (const w of card.warnings) parts.push(el('div', 'warn', `⚠ ${w}`));
    for (const n of card.notes) parts.push(el('div', 'muted', n));
    if (card.refusal !== null) parts.push(el('div', 'refusal', card.refusal));
    const phase = PHASE_TEXT[card.phase];
    if (phase) parts.push(el('div', 'muted', phase));
    s.lines = el('pre', '', card.lines.join('\n'));
    parts.push(s.lines);
    if (card.outcome !== null) {
      parts.push(
        el('div', card.outcome.ok ? 'ok' : 'fail', card.outcome.text),
      );
    }
    const buttons = el('div', 'buttons');
    if (card.phase !== 'running') {
      const dismiss = el(
        'button',
        '',
        card.phase === 'done' ? 'Close' : 'Dismiss',
      ) as HTMLButtonElement;
      dismiss.type = 'button';
      dismiss.addEventListener('click', () => act.dismiss(card.id));
      buttons.append(dismiss);
    }
    if (card.confirm !== null) {
      const ok = el('button', '', card.confirm) as HTMLButtonElement;
      ok.type = 'button';
      ok.disabled = true;
      const press = () => s.pressedAt = performance.now();
      ok.addEventListener('pointerdown', press);
      ok.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') press();
      });
      ok.addEventListener('click', () => {
        if (ok.disabled || s.pressedAt < s.armedAt) return;
        ok.disabled = true;
        act.confirm(card.id);
      });
      setTimeout(() => {
        if (shown.get(card.id) === s && s.el.contains(ok)) ok.disabled = false;
      }, ARM_MS);
      buttons.append(ok);
    }
    parts.push(buttons);
    const e = el('div', 'action-card', '', parts);
    e.dataset.phase = card.phase;
    return e;
  }

  return {
    show(raw) {
      const cards = Array.isArray(raw) ? raw as ActionCard[] : [];
      const ids = new Set(cards.map((c) => c.id));
      for (const id of shown.keys()) if (!ids.has(id)) shown.delete(id);
      for (const card of cards) {
        const { lines: _lines, ...rest } = card;
        const sig = JSON.stringify(rest);
        const was = shown.get(card.id);
        if (was?.sig === sig) continue;
        const s: Shown = {
          sig,
          el: document.createElement('div'),
          lines: document.createElement('pre'),
          armedAt: performance.now() + ARM_MS,
          pressedAt: -Infinity,
        };
        shown.set(card.id, s);
        s.el = cardEl(card, s);
      }
      column.replaceChildren(...cards.map((c) => shown.get(c.id)!.el));
      column.hidden = cards.length === 0;
      return {
        shown: cards.length,
        waiting: cards.filter((c) => c.phase !== 'done').length,
      };
    },
    progress(id, line) {
      const s = shown.get(id);
      if (s === undefined) return;
      s.lines.textContent = s.lines.textContent
        ? `${s.lines.textContent}\n${line}`
        : line;
      s.lines.scrollTop = s.lines.scrollHeight;
    },
  };
}
