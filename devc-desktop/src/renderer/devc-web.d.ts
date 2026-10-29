// devc web's page modules (`devc/web/static/`, plain JSDoc-typed JavaScript), as the Containers
// pane imports them: `build.mjs` maps `devc-web/` to that folder. Only what the pane uses.

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
    opts: { tileArea: unknown; inUse: unknown; standalone: boolean },
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
    } | null,
  ): void;
}

declare module 'devc-web/ui.js' {
  export type MenuItem =
    | [string, () => void, boolean?, Node?]
    | null;
  export function useMenuHost(
    host: ((x: number, y: number, items: MenuItem[]) => void) | null,
  ): void;
}

declare module 'devc-web/lib/protocol_version.js' {
  export const PROTOCOL: number;
}
