// The title bar: the window's title, which the main process sends whenever it changes.

declare global {
  interface Window {
    titleBar: {
      platform: string;
      onTitle(cb: (title: string) => void): void;
    };
  }
}

const title = document.getElementById('title')!;
document.body.dataset.platform = window.titleBar.platform;
window.titleBar.onTitle((t) => {
  title.textContent = t;
});

export {};
