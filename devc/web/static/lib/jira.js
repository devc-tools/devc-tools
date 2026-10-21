// Jira issue keys in a branch name, and the page that opens one. Pure (no DOM), shared with the
// Deno tests (`devc/tests/web_jira_test.ts`); `app.js` offers each key in the menus of whatever
// shows that branch. The config is `"jira"` from devc's global config, as the server sends it.

/** @typedef {{pattern: string, url: string}} JiraConfig */

/** At most this many keys from one branch: each is a menu item. */
const MAX_KEYS = 3;

/**
 * The distinct keys `jira.pattern` finds in `branch`, upper-cased, in order, at most
 * {@link MAX_KEYS}. Case-insensitive, and only where no letter or digit adjoins the match, so
 * `AB-\d+` finds nothing in `XAB-12`. Empty without a branch or config, or when the pattern
 * does not compile.
 *
 * @param {string | null | undefined} branch
 * @param {JiraConfig | null} jira
 * @returns {string[]}
 */
export function jiraKeys(branch, jira) {
  if (!branch || !jira) return [];
  let re;
  try {
    re = new RegExp(
      `(?<![A-Za-z0-9])(?:${jira.pattern})(?![A-Za-z0-9])`,
      'gi',
    );
  } catch {
    return [];
  }
  const keys = [];
  for (const m of branch.matchAll(re)) {
    const key = m[0].toUpperCase();
    if (key === '' || keys.includes(key)) continue;
    keys.push(key);
    if (keys.length === MAX_KEYS) break;
  }
  return keys;
}

/**
 * `jira.url` with every `{key}` replaced by `key`, URI-encoded.
 *
 * @param {JiraConfig} jira
 * @param {string} key
 * @returns {string}
 */
export function jiraUrl(jira, key) {
  return jira.url.replaceAll('{key}', encodeURIComponent(key));
}
