import { assertEquals, assertMatch } from 'jsr:@std/assert';
import { buildSuffix } from '../../version-info/version_info.ts';
import { versionLine } from '../version_info.ts';
import { VERSION } from '../help.ts';

Deno.test('buildSuffix: exactly the clean release tag adds nothing', () => {
  assertEquals(buildSuffix('v0.3.0-0-g9b4d3f2', '0.3.0'), '');
});

Deno.test('buildSuffix: the release tag with uncommitted changes', () => {
  assertEquals(buildSuffix('v0.3.0-0-g9b4d3f2-dirty', '0.3.0'), '+dirty');
});

Deno.test('buildSuffix: commits past the release tag', () => {
  assertEquals(buildSuffix('v0.3.0-6-g0222e50', '0.3.0'), '+6.g0222e50');
  assertEquals(
    buildSuffix('v0.3.0-6-g0222e50-dirty', '0.3.0'),
    '+6.g0222e50.dirty',
  );
});

Deno.test('buildSuffix: a tag other than VERSION drops the count', () => {
  assertEquals(buildSuffix('v0.2.2-4-gabc1234', '0.3.0'), '+gabc1234');
  assertEquals(
    buildSuffix('v0.2.2-0-gabc1234-dirty', '0.3.0'),
    '+gabc1234.dirty',
  );
});

Deno.test('buildSuffix: prerelease tags compare whole', () => {
  assertEquals(
    buildSuffix('v0.4.0-rc.1-2-gabc1234', '0.4.0-rc.1'),
    '+2.gabc1234',
  );
});

Deno.test('buildSuffix: no matching tag (--always) gives the bare sha', () => {
  assertEquals(buildSuffix('0222e50', '0.3.0'), '+g0222e50');
  assertEquals(buildSuffix('0222e50-dirty', '0.3.0'), '+g0222e50.dirty');
});

Deno.test('buildSuffix: unrecognized output adds nothing', () => {
  assertEquals(buildSuffix('something else', '0.3.0'), '');
});

Deno.test('versionLine from source says so', () => {
  assertMatch(
    versionLine(),
    new RegExp(
      `^devc ${VERSION.replaceAll('.', '\\.')}(\\+\\S+)? \\(source\\)$`,
    ),
  );
});
