import { assertEquals, assertMatch, assertNotEquals } from 'jsr:@std/assert@^1';
import {
  containerNameForLocalFolder,
  imageNameForContainerName,
} from '../container.ts';

Deno.test('containerNameForLocalFolder matches devc-<basename>-<hash>', async () => {
  const name = await containerNameForLocalFolder('/workspaces/some-tool');
  assertMatch(name, /^devc-some-tool-[0-9a-f]{8}$/);
});

Deno.test('containerNameForLocalFolder is deterministic', async () => {
  const a = await containerNameForLocalFolder('/workspaces/some-tool');
  const b = await containerNameForLocalFolder('/workspaces/some-tool');
  assertEquals(a, b);
});

Deno.test('containerNameForLocalFolder disambiguates folders with the same basename', async () => {
  const a = await containerNameForLocalFolder('/home/alice/some-tool');
  const b = await containerNameForLocalFolder('/home/bob/some-tool');
  assertNotEquals(a, b);
});

Deno.test('containerNameForLocalFolder falls back to workspace for an empty basename', async () => {
  const name = await containerNameForLocalFolder('/');
  assertMatch(name, /^devc-workspace-[0-9a-f]{8}$/);
});

// Docker's repository-name grammar: lowercase alphanumeric components joined by `.`, `_`, `__`
// or a run of `-`, with no two different separators adjacent.
const IMAGE_REPO = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

for (
  const folder of [
    '/workspaces/_wksp',
    '/home/me/.dotfiles',
    '/src/foo_',
    '/src/a___b',
    '/src/a..b',
  ]
) {
  Deno.test(`imageNameForContainerName yields a valid image repository for ${folder}`, async () => {
    const container = await containerNameForLocalFolder(folder);
    assertMatch(imageNameForContainerName(container), IMAGE_REPO);
  });
}

Deno.test('imageNameForContainerName collapses mixed separators', () => {
  assertEquals(
    imageNameForContainerName('devc-_wksp-c2d4bfca'),
    'devc-wksp-c2d4bfca',
  );
});

Deno.test('imageNameForContainerName leaves an already-valid name unchanged', async () => {
  const container = await containerNameForLocalFolder('/workspaces/some-tool');
  assertEquals(imageNameForContainerName(container), container);
});

Deno.test('containerNameForLocalFolder keeps the basename as-is (container identity is unchanged)', async () => {
  const name = await containerNameForLocalFolder('/workspaces/_wksp');
  assertMatch(name, /^devc-_wksp-[0-9a-f]{8}$/);
});
