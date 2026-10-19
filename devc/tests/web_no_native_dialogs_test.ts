import { assertEquals } from 'jsr:@std/assert';

// The desktop app shows devc web with native dialogs turned off (`disableDialogs`), where
// `alert()` does nothing, `confirm()` answers false and `prompt()` null, all unasked. The page
// asks with `confirmDialog` / `promptDialog` instead.
const NATIVE = /(?<![\w$.])(?:window\.)?(alert|confirm|prompt)\s*\(/;

Deno.test('the page calls no alert(), confirm() or prompt()', async () => {
  const root = new URL('../web/static/', import.meta.url).pathname;
  const found: string[] = [];
  for await (const path of pageScripts(root)) {
    const lines = (await Deno.readTextFile(path)).split('\n');
    lines.forEach((line, i) => {
      const code = line.trimStart();
      if (
        code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')
      ) {
        return;
      }
      if (NATIVE.test(line)) found.push(`${path.slice(root.length)}:${i + 1}`);
    });
  }
  assertEquals(found, []);
});

/** Every `.js` file under `dir`, `vendor/` aside. */
async function* pageScripts(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}${e.name}`;
    if (e.isDirectory && e.name !== 'vendor') yield* pageScripts(`${path}/`);
    else if (e.isFile && e.name.endsWith('.js')) yield path;
  }
}
