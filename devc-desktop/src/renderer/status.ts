// The status view: what `devc web` is doing while it starts, or why it stopped, and Restart.

export interface Status {
  phase: 'starting' | 'failed';
  /** One line: what is happening, or why it stopped. */
  message: string;
  /** The child's last stderr lines, when it failed or exited. */
  stderr: string[];
}

declare global {
  interface Window {
    devcDesktop: {
      status(): Promise<Status>;
      onStatus(cb: (s: Status) => void): void;
      restart(): void;
    };
  }
}

const $ = (id: string) => document.getElementById(id)!;

function show(s: Status): void {
  document.body.dataset.phase = s.phase;
  $('message').textContent = s.message;
  $('stderr').textContent = s.stderr.join('\n');
}

$('restart').addEventListener('click', () => window.devcDesktop.restart());
window.devcDesktop.onStatus(show);
void window.devcDesktop.status().then(show);
