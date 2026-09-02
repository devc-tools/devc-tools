// Host ↔ container path translation over a container's live mount table — the
// `ContainerMount[]` that `getContainerMounts` returns from `docker inspect`.
//
// Pure: no filesystem access, no `docker` call, no symlink resolution. The table is taken
// as given (`getContainerMounts` documents that it does not resolve symlinks in `source`,
// and that the caller does).
//
// ⚠️ **This only works host-side.** Inside a container the same table reports a bind
// source like `/run/host_mark/Users` rather than the host path that was mounted, so a
// container cannot derive host paths at all — which is why the guard that consumes this
// runs on the host.

import type { ContainerMount } from './container.ts';
import { normalizePath } from './paths.ts';
import { isAbsolutePosix, relativeUnderPosix, resolvePosix } from './posix.ts';

/** A mount that covers a path, and the path's location inside it ('' for the mount root). */
export interface MountMatch {
  mount: ContainerMount;
  relative: string;
}

/**
 * Slash-normalizes `p` and collapses any `.`/`..` segments, so `..` cannot escape a mount
 * by string trickery. Returns null for a non-absolute path: this module is pure and has no
 * cwd to resolve one against.
 *
 * Note this deliberately uses `paths.ts`'s `normalizePath` — *not* `container.ts`'s
 * private wrapper of the same name, which lowercases for `devcontainer.local_folder` label
 * comparison. Lowercasing a container path here would be a bug on Linux.
 */
function canonicalPath(p: string): string | null {
  const normalized = normalizePath(p);
  if (!isAbsolutePosix(normalized)) return null;
  // The root prefix `resolvePosix` must keep: `/`, or a `C:/`-style drive.
  const root = normalized.match(/^([a-zA-Z]:)?\//)![0];
  return resolvePosix(root, normalized.slice(root.length));
}

/**
 * `path`'s location under `base`, or null when `base` does not cover it. Both are already
 * canonical, so this is segment-aware by construction rather than a bare `startsWith`:
 * `/a/bc` does not match a base of `/a/b`.
 *
 * ⚠️ Equality is handled *before* delegating: `relativeUnderPosix(base, path)` returns null
 * when `path === base` — correct for its own callers (there is nothing to mirror), wrong
 * here, where an exact match is a valid match onto the mount root.
 */
function locationUnder(base: string, path: string): string | null {
  if (path === base) return '';
  return relativeUnderPosix(base, path);
}

function findMount(
  path: string,
  mounts: ContainerMount[],
  side: 'source' | 'destination',
): MountMatch | null {
  const target = canonicalPath(path);
  if (target === null) return null;

  let best: MountMatch | null = null;
  let bestLength = -1;
  for (const mount of mounts) {
    // Volumes are skipped in both directions: a volume's `source` is a docker-managed
    // `/var/lib/docker/…` directory that means nothing to a host user, and its
    // `destination` has no host equivalent worth returning. A path that falls only inside
    // a volume is genuinely not translatable, and null is the answer the guard wants.
    if (mount.type !== 'bind') continue;
    const base = canonicalPath(mount[side]);
    if (base === null) continue;
    const relative = locationUnder(base, target);
    if (relative === null) continue;
    // Mounts nest, so the longest base wins rather than the first that matches.
    if (base.length > bestLength) {
      best = { mount, relative };
      bestLength = base.length;
    }
  }
  return best;
}

/** The bind mount whose host `source` covers `hostPath`, or null when none does. */
export function findMountForHostPath(
  hostPath: string,
  mounts: ContainerMount[],
): MountMatch | null {
  return findMount(hostPath, mounts, 'source');
}

/** The bind mount whose `destination` covers `containerPath`, or null when none does. */
export function findMountForContainerPath(
  containerPath: string,
  mounts: ContainerMount[],
): MountMatch | null {
  return findMount(containerPath, mounts, 'destination');
}

/** The container path for `hostPath`, or null when no bind mount covers it. */
export function hostToContainerPath(
  hostPath: string,
  mounts: ContainerMount[],
): string | null {
  const match = findMountForHostPath(hostPath, mounts);
  if (match === null) return null;
  return joinUnder(match.mount.destination, match.relative);
}

/** The host path for `containerPath`, or null when no bind mount covers it. */
export function containerToHostPath(
  containerPath: string,
  mounts: ContainerMount[],
): string | null {
  const match = findMountForContainerPath(containerPath, mounts);
  if (match === null) return null;
  return joinUnder(match.mount.source, match.relative);
}

/**
 * The other side of a match: the mount path itself when `relative` is '' (an exact match
 * yields the other side unchanged), otherwise `relative` resolved under it. `relative`
 * never contains `..` — it came out of two canonical paths.
 *
 * Null when the other side is not itself an absolute path: only the side that was matched
 * against is known to be one, and a mount we cannot express on both sides does not
 * translate.
 */
function joinUnder(mountPath: string, relative: string): string | null {
  const base = canonicalPath(mountPath);
  if (base === null) return null;
  return resolvePosix(base, relative);
}
