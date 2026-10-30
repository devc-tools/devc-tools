// The rail between the left column (devc web's /sidebar, the Containers pane) and /main: dragging
// it resizes the column, and a click on it shows the column while hidden (Layout → Sidebar). The
// main process owns the views' bounds.

declare global {
  interface Window {
    rail: { drag(dx: number): void; click(): void };
  }
}

const body = document.body;
body.addEventListener('pointerdown', (e) => {
  body.setPointerCapture(e.pointerId);
  body.classList.add('dragging');
  let last = e.screenX;
  let moved = false;
  const move = (m: PointerEvent) => {
    const dx = m.screenX - last;
    last = m.screenX;
    if (dx === 0) return;
    moved = true;
    window.rail.drag(dx);
  };
  const up = () => {
    if (!moved) window.rail.click();
    body.classList.remove('dragging');
    body.removeEventListener('pointermove', move);
    body.removeEventListener('pointerup', up);
  };
  body.addEventListener('pointermove', move);
  body.addEventListener('pointerup', up);
});

export {};
