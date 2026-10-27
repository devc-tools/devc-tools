// The page's PR review for a project on this machine (`PrBackend`, see `environment.ts`): the
// same built-in recipes a container's `devc-bridge` runs (`devc-bridge/builtin/gh-pr-*`, so the
// GraphQL has one copy), run directly on the host with the user's own `gh`.
//
// **Every PR capability is granted** ({@link HOST_PR_GRANTS}). Grants exist to limit what an
// agent inside a container can make the host do; a host project's page already has a host shell
// with the user's own `gh`, so they would limit nothing here.
//
// The recipes read their pinned line from a policy file, as the bridge's would: one is written
// before every run (the branch can change between runs) under `~/.cache/devc/web-pr-policy/`,
// keyed by the repo folder. Their output is still what GitHub sent, so `pr_review.ts` parses it
// as defensively as a container's.

import { createHash } from 'node:crypto';
import { dirname, fromFileUrl, join } from 'jsr:@std/path';
import {
  type BridgeCapability,
  isGitHubRemote,
  type PolicyLine,
  resolvePin,
  serializePolicy,
} from '@devc-tools/core/bridge.ts';
import type { Environment, PrBackend } from './environment.ts';

/** Every PR capability, in canonical order: see the module header. */
export const HOST_PR_GRANTS: BridgeCapability[] = [
  'gh-pr-read',
  'gh-pr-reply',
  'gh-pr-pending-review',
  'gh-pr-viewed',
  'gh-pr-resolve',
  'gh-pr-request-review',
];

/** The recipes a host project runs: every `gh-pr-*` built-in. */
const RECIPE_PREFIX = 'gh-pr-';

/** The policy key for repo folder `root`: `web-` and 16 hex chars of its SHA-256. */
export function hostPrKey(root: string): string {
  return `web-${
    createHash('sha256').update(root, 'utf8').digest('hex').slice(0, 16)
  }`;
}

/** Where the synthesized policies go, under `home`. */
export function hostPolicyDir(home: string): string {
  return `${home}/.cache/devc/web-pr-policy`;
}

/** Writes `text` to `path` (`0600`) through a temp file renamed over it. */
async function writePrivate(path: string, text: string): Promise<void> {
  const dir = dirname(path);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  await Deno.chmod(dir, 0o700);
  const tmp = await Deno.makeTempFile({ dir, prefix: '.policy-' });
  try {
    await Deno.chmod(tmp, 0o600);
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** The built-in recipes embedded beside this module (a checkout's, or the binary's `--include`). */
const EMBEDDED_BUILTINS = new URL(
  '../../devc-bridge/builtin/',
  import.meta.url,
);

/**
 * Copies every embedded `gh-pr-*` recipe into `dir` (`0755`), through a fresh sibling renamed
 * over it, as `devc-bridge/host/config.ts`'s `materializeBuiltins` does, so a concurrent reader
 * never sees half a set. Needed in the compiled binary: `deno compile` serves an included file
 * only to `import.meta.url`-relative reads, and `bash` cannot exec one.
 */
export async function materializeHostBuiltins(
  dir: string,
  from: URL = EMBEDDED_BUILTINS,
): Promise<void> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(from)) {
    if (entry.isFile && entry.name.startsWith(RECIPE_PREFIX)) {
      names.push(entry.name);
    }
  }
  const parent = dirname(dir);
  await Deno.mkdir(parent, { recursive: true, mode: 0o700 });
  const fresh = await Deno.makeTempDir({
    dir: parent,
    prefix: 'web-builtin.tmp-',
  });
  try {
    for (const name of names.sort()) {
      const target = join(fresh, name);
      await Deno.writeFile(target, await Deno.readFile(new URL(name, from)));
      await Deno.chmod(target, 0o755);
    }
    await Deno.chmod(fresh, 0o755);
    const old = `${fresh}.old`;
    let hadOld = true;
    try {
      await Deno.rename(dir, old);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      hadOld = false;
    }
    await Deno.rename(fresh, dir);
    if (hadOld) await Deno.remove(old, { recursive: true });
  } catch (e) {
    await Deno.remove(fresh, { recursive: true }).catch(() => {});
    throw e;
  }
}

/**
 * The folder the recipes run from: a checkout's own `devc-bridge/builtin/`; in the compiled
 * binary, `~/.cache/devc/web-builtin/`, materialized on the first call of each server.
 */
export function hostBuiltins(home: string): () => Promise<string> {
  let ready: Promise<string> | null = null;
  return () => {
    if (!Deno.build.standalone) {
      return Promise.resolve(fromFileUrl(EMBEDDED_BUILTINS));
    }
    ready ??= (async () => {
      const dir = `${home}/.cache/devc/web-builtin`;
      await materializeHostBuiltins(dir);
      return dir;
    })();
    ready.catch(() => {
      ready = null;
    });
    return ready;
  };
}

/** The pinned line for repo folder `root`, or why there is none. */
async function hostPin(
  root: string,
): Promise<{ problem: string } | { line: PolicyLine }> {
  const pin = await resolvePin(root);
  if (!pin.ok) return { problem: (pin as { reason: string }).reason };
  if (!isGitHubRemote(pin.record.remote)) {
    return { problem: `${pin.record.remote} is not a GitHub remote` };
  }
  return {
    line: {
      ...pin.record,
      repo: root,
      target: root,
      grants: HOST_PR_GRANTS,
    },
  };
}

/** A host project's {@link PrBackend}: see the module header. */
export function hostPrBackend(opts: {
  env: Pick<Environment, 'runLimited'>;
  home: string;
  /** The recipes' folder: see {@link hostBuiltins}. */
  builtins: () => Promise<string>;
}): PrBackend {
  const policyDir = hostPolicyDir(opts.home);
  return {
    async pin(root) {
      const pin = await hostPin(root);
      return 'problem' in pin
        ? { problem: pin.problem }
        : { target: root, grants: HOST_PR_GRANTS };
    },
    async run(command, target, args, limits) {
      const pin = await hostPin(target);
      if ('problem' in pin) {
        return { kind: 'exit', code: 2, stdout: '', stderr: pin.problem };
      }
      const key = hostPrKey(target);
      await writePrivate(
        `${policyDir}/${key}.conf`,
        serializePolicy({ repos: [pin.line] }),
      );
      const dir = await opts.builtins();
      return await opts.env.runLimited({
        cmd: [join(dir, command), '--repo', target, ...args],
        cwd: '/',
        env: { DEVC_BRIDGE_KEY: key, DEVC_BRIDGE_POLICY_DIR: policyDir },
      }, limits);
    },
  };
}
