// devc web's page modules (`devc/web/static/`, plain JSDoc-typed JavaScript), as the Containers
// pane imports them: `build.mjs` maps `devc-web/` to that folder. Only what the pane uses.

declare module 'devc-web/layout.js' {
  export interface Tile {
    id: string;
    ref: { localFolder: string; pane_id: string } | null;
    element: HTMLElement;
    setTitle(title: string, muted?: string): void;
    setActions(el: Node | null): void;
    focus(): void;
  }
  export interface Tiling {
    addBeside(
      id: string | null,
      ref: { localFolder: string; pane_id: string },
      where: 'right' | 'below' | 'stack',
    ): Tile;
    reveal(id: string): void;
    close(id: string): void;
    save(): unknown;
    load(saved: unknown): boolean;
    tiles(): Tile[];
    focusedTile(): Tile | null;
    isEmpty(): boolean;
  }
  export function createTiling(
    root: HTMLElement,
    hooks: {
      mount(tile: Tile): void;
      unmount(tile: Tile): void;
      visibility(tile: Tile, visible: boolean): void;
      focused(tile: Tile | null): void;
      changed(): void;
      tileMenu(tile: Tile, e: MouseEvent): void;
      stackMenu(stackId: string, e: MouseEvent): void;
      tabDoubleClick(tile: Tile): void;
    },
  ): Tiling;
}

declare module 'devc-web/lib/layout_state.js' {
  export function parseSavedLayout(
    text: string | null,
  ): Record<string, unknown> | null;
}

declare module 'devc-web/client.js' {
  export function connect(): void;
  export function useBundledEndpoint(o: {
    origin: string;
    desktopToken: string;
    protocol: number;
    onProtocol: (ok: boolean, server: unknown) => void;
  }): void;
}

declare module 'devc-web/containers.js' {
  export function mountContainers(
    root: HTMLElement,
    opts: {
      tileArea: unknown;
      inUse: unknown;
      standalone: boolean;
      onFold?: (open: boolean) => void;
    },
  ): unknown;
}

declare module 'devc-web/remote.js' {
  export function remoteTileArea(): { tileArea: unknown };
  export function remoteInUse(): { link: unknown };
  export function serveContainers(
    remote: unknown,
    inUse: unknown,
    section: unknown,
  ): void;
}

declare module 'devc-web/menus.js' {
  export function useAppActions(
    actions: {
      push(localFolder: string, folder: string): void;
      project(action: 'start' | 'stop' | 'down', localFolder: string): void;
      terminal(localFolder: string, folder: string): void;
    } | null,
  ): void;
}

declare module 'devc-web/ui.js' {
  export type MenuItem =
    | [
      string,
      () => void,
      boolean?,
      Node?,
      { disabled?: boolean; title?: string }?,
    ]
    | null;
  export function useMenuHost(
    host: ((x: number, y: number, items: MenuItem[]) => void) | null,
  ): void;
}

declare module 'devc-web/lib/protocol_version.js' {
  export const PROTOCOL: number;
}

declare module 'devc-web/lib/themes.js' {
  export type ThemeColors = Record<string, string> & {
    bg: string;
    panel: string;
    border: string;
    text: string;
    accent: string;
    sidebarHead: string;
  };
  export type Mode = 'dark' | 'light';
  export interface Theme {
    name: string;
    label: string;
    /** The dark palette. */
    colors: ThemeColors;
    light: ThemeColors;
  }
  export const THEMES: readonly Theme[];
  export const DEFAULT_THEME: string;
  export function themeNamed(name: unknown): Theme;
  export function themeColors(theme: Theme, mode: Mode): ThemeColors;
  export function themeVars(theme: Theme, mode?: Mode): Record<string, string>;
  export function terminalTheme(
    theme: Theme,
    mode: Mode,
  ): Record<string, string>;
  export function themeFromHash(hash: string): Theme | null;
  export function appearanceNamed(v: unknown): 'system' | 'light' | 'dark';
}

declare module 'devc-web/lib/links.js' {
  export type Link =
    & { start: number; end: number }
    & (
      | { kind: 'url'; url: string }
      | { kind: 'file'; path: string; line?: number; column?: number }
    );
  export function resolvePath(cwd: string, path: string): string | null;
}

declare module 'devc-web/renderer.js' {
  import type { Link } from 'devc-web/lib/links.js';
  type Cell = { column: number; row: number };
  export interface TermColors {
    theme: Record<string, string>;
    minimumContrastRatio: number;
  }
  export interface Renderer {
    write(bytes: Uint8Array, cols?: number, rows?: number): void;
    resize(): { cols: number; rows: number } | null;
    onData(cb: (data: string) => void): void;
    onWheel(cb: (ev: WheelEvent) => void): void;
    focus(): void;
    dispose(): void;
    metrics(): {
      left: number;
      top: number;
      cellWidth: number;
      cellHeight: number;
      cols: number;
      rows: number;
    } | null;
    selection(): string;
    highlight(anchor: Cell, cursor: Cell): void;
    clearHighlight(): void;
    linkAt(cell: Cell): Link | null;
    setColors(colors: TermColors): void;
  }
  export function createRenderer(
    element: HTMLElement,
    opts?: {
      linkHint?: string;
      linkModifier?: (ev: MouseEvent | KeyboardEvent) => boolean;
      colors?: TermColors;
      openUrl?: (url: string) => void;
    },
  ): Renderer;
}

declare module 'devc-web/term_mouse.js' {
  import type { Renderer } from 'devc-web/renderer.js';
  import type { Link } from 'devc-web/lib/links.js';
  type Cell = { column: number; row: number };
  export function attachTerminalMouse(
    termEl: HTMLElement,
    renderer: Renderer,
    hooks: {
      mouse(
        cmd: {
          action: 'down' | 'up' | 'drag';
          button: 'left' | 'right' | 'middle';
          column: number;
          row: number;
        },
      ): void;
      copyRange(anchor: Cell, cursor: Cell): void;
      openLink(link: Link): void;
      contextMenu(ev: MouseEvent): void;
      frames(): number;
      linkModifier(ev: MouseEvent | KeyboardEvent): boolean;
      active(): boolean;
    },
  ): () => void;
}

declare module 'devc-web/lib/input.js' {
  export function createWheelAccumulator(): (
    deltaY: number,
    cellHeight: number,
    deltaMode?: number,
  ) => { direction: 'up' | 'down'; lines: number } | null;
  export function decodeBase64(b64: string): Uint8Array;
  export function encodeInput(text: string): string;
  export function wrapPaste(text: string): string;
}
