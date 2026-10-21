import { assertEquals } from 'jsr:@std/assert';
import { jiraKeys, jiraUrl } from '../web/static/lib/jira.js';

const AB = {
  pattern: 'AB-\\d+',
  url: 'https://acme.atlassian.net/browse/{key}',
};

Deno.test('jiraKeys finds each distinct key, upper-cased, in order, at most three', () => {
  const cases: [string, string, string[]][] = [
    ['feature/AB-12345-fix-thing', 'AB-\\d+', ['AB-12345']],
    ['ab-12345_fix', 'AB-\\d+', ['AB-12345']],
    ['AB-1-and-AB-2-and-ab-1', 'AB-\\d+', ['AB-1', 'AB-2']],
    ['AB-1-AB-2-AB-3-AB-4', 'AB-\\d+', ['AB-1', 'AB-2', 'AB-3']],
    ['XAB-12', 'AB-\\d+', []],
    ['AB-12x', 'AB-\\d+', []],
    ['cd-7/ab-9', '(?:AB|CD)-\\d+', ['CD-7', 'AB-9']],
    ['main', 'AB-\\d+', []],
    ['AB-12', '(', []],
  ];
  for (const [branch, pattern, keys] of cases) {
    assertEquals(jiraKeys(branch, { ...AB, pattern }), keys, branch);
  }
});

Deno.test('jiraKeys is empty without a branch or a config, and skips empty matches', () => {
  assertEquals(jiraKeys('', AB), []);
  assertEquals(jiraKeys(null, AB), []);
  assertEquals(jiraKeys(undefined, AB), []);
  assertEquals(jiraKeys('AB-1', null), []);
  assertEquals(jiraKeys('-AB-1', { ...AB, pattern: 'AB-\\d*|' }), ['AB-1']);
});

Deno.test('jiraUrl replaces every {key}, URI-encoded', () => {
  assertEquals(jiraUrl(AB, 'AB-1'), 'https://acme.atlassian.net/browse/AB-1');
  assertEquals(
    jiraUrl({ ...AB, url: 'https://j.example/{key}?q={key}' }, 'A B/1'),
    'https://j.example/A%20B%2F1?q=A%20B%2F1',
  );
});
