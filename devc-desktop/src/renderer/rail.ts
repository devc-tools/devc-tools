// The rail between the left column (devc web's /sidebar, the Containers pane) and /main: dragging
// it resizes the column. The main process owns the views' bounds.

declare global {
  interface Window {
    rail: { drag(dx: number): void };
  }
}

const body = document.body;
body.addEventListener('pointerdown', (e) => {
  body.setPointerCapture(e.pointerId);
  body.classList.add('dragging');
  let last = e.screenX;
  const move = (m: PointerEvent) => {
    const dx = m.screenX - last;
    last = m.screenX;
    if (dx !== 0) window.rail.drag(dx);
  };
  const up = () => {
    body.classList.remove('dragging');
    body.removeEventListener('pointermove', move);
    body.removeEventListener('pointerup', up);
  };
  body.addEventListener('pointermove', move);
  body.addEventListener('pointerup', up);
});

export {};
