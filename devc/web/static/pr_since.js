// A PR file's text at its Since point and at the PR's head (`pr_file_at`), shared by a diff tile's
// **Compare** and the PR row's **Since viewed** filter, so both compare the same two texts.

import { call } from './client.js';

/**
 * Reads `file` at `option.headSha` and at `headSha`. A Viewed mark's file is read at its recorded
 * path; the review's at the file's path now, else (renamed since) its previous path. A side the
 * commit has no such file in (added since, or removed) reads as empty. Never throws.
 *
 * @param {{localFolder: string, root: string}} repo
 * @param {{path: string, previousPath?: string | null}} file
 * @param {import('./lib/since.js').SinceOption} option
 * @param {string} headSha
 * @returns {Promise<{ok: true, texts: [string, string]} | {ok: false, message: string}>}
 */
export async function readSinceTexts(repo, file, option, headSha) {
  /** @param {string} path @param {string} sha @returns {Promise<any>} */
  const read = (path, sha) =>
    call({ type: 'pr_file_at', ...repo, path, sha }).then(
      (r) => r,
      (e) => ({ available: false, message: String(e?.message ?? e) }),
    );
  const readBefore = async () => {
    const first = await read(option.path ?? file.path, option.headSha);
    return option.path === null && first?.reason === 'missing' &&
        typeof file.previousPath === 'string'
      ? read(file.previousPath, option.headSha)
      : first;
  };
  const [before, now] = await Promise.all([
    readBefore(),
    read(file.path, headSha),
  ]);
  /** @param {any} r */
  const text = (r) =>
    r?.available === true
      ? String(r.text)
      : r?.reason === 'missing'
      ? ''
      : null;
  const texts = [text(before), text(now)];
  if (texts[0] === null || texts[1] === null) {
    const failed = texts[0] === null ? before : now;
    return { ok: false, message: String(failed?.message ?? 'failed') };
  }
  return { ok: true, texts: /** @type {[string, string]} */ (texts) };
}
