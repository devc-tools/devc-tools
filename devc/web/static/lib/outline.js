// The sidebar's Outline of a JavaScript or TypeScript file: its tests (`describe` / `it` /
// `test`, `Deno.test`, `t.step`, nested as written) and its top-level declarations, read from the
// file's Lezer parse tree (`@lezer/javascript`, any dialect). Pure: it takes the tree and the text
// and touches neither the DOM nor CodeMirror, so `devc/tests/web_outline_test.ts` runs it on trees
// parsed in Deno. `viewer.js` calls it on the editor's own tree. See `.plans/devc-web-outline.md`.

/** The most items an outline lists; past it, `truncated` is set. `protocol.ts` checks the same. */
export const MAX_OUTLINE_ITEMS = 1000;

/** The longest item name, in UTF-16 units; a longer one is cut to one less and `…`. */
export const MAX_OUTLINE_NAME = 120;

/** The `lib/languages.js` languages an outline is made for. */
export const OUTLINE_LANGUAGES = Object.freeze([
  'javascript',
  'jsx',
  'typescript',
  'tsx',
]);

/**
 * @typedef {'suite' | 'test' | 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum'}
 *   OutlineKind
 */

/**
 * One row of an outline. Items come in pre-order: a parent, then its children, each one `depth`
 * deeper.
 *
 * @typedef {object} OutlineItem
 * @property {OutlineKind} kind
 * @property {string} name      at most {@link MAX_OUTLINE_NAME} UTF-16 units
 * @property {number} line      1-based line of the node's start
 * @property {number} endLine   1-based line of the node's end
 * @property {number} depth     0 at the top level
 * @property {string[]} modifiers  `skip`, `only`, `each`…, in the order written
 */

/**
 * The parts of a Lezer `SyntaxNode` used here (`@lezer/common`).
 *
 * @typedef {object} SyntaxNodeLike
 * @property {string} name
 * @property {number} from
 * @property {number} to
 * @property {SyntaxNodeLike | null} firstChild
 * @property {SyntaxNodeLike | null} nextSibling
 * @property {(name: string) => SyntaxNodeLike | null} getChild
 */

const SUITES = new Set(['describe', 'suite', 'context']);
const TESTS = new Set(['it', 'test', 'bench']);
const DENO_TESTS = new Set(['test', 'bench']);
const MODIFIERS = new Set([
  'only',
  'skip',
  'todo',
  'each',
  'concurrent',
  'sequential',
  'failing',
  'fails',
  'ignore',
  'skipIf',
  'runIf',
]);
/** Nodes whose bodies are not searched for tests, unless passed to a test call. */
const FUNCTIONS = new Set([
  'ArrowFunction',
  'FunctionExpression',
  'FunctionDeclaration',
  'ClassDeclaration',
  'ClassExpression',
  'MethodDeclaration',
]);
/** Punctuation and comments among an `ArgList`'s children: not arguments. */
const NOT_ARGUMENTS = new Set([
  '(',
  ')',
  ',',
  'LineComment',
  'BlockComment',
]);

/** Thrown to stop the walk at {@link MAX_OUTLINE_ITEMS}. */
class Full extends Error {}

/**
 * The outline of a parsed JavaScript or TypeScript file.
 *
 * @param {{topNode: SyntaxNodeLike}} tree  a Lezer `Tree`
 * @param {string} text  the text it was parsed from
 * @returns {{items: OutlineItem[], truncated: boolean}}
 */
export function outlineOf(tree, text) {
  /** @type {OutlineItem[]} */
  const items = [];
  const lineOf = lineFinder(text);
  /** @param {SyntaxNodeLike} n */
  const src = (n) => text.slice(n.from, n.to);

  /**
   * @param {OutlineKind} kind @param {string} name @param {number} from @param {number} to
   * @param {number} depth @param {string[]} [modifiers]
   */
  const push = (kind, name, from, to, depth, modifiers = []) => {
    if (items.length >= MAX_OUTLINE_ITEMS) throw new Full();
    items.push({
      kind,
      name: cut(name),
      line: lineOf(from),
      endLine: lineOf(to),
      depth,
      modifiers,
    });
  };

  /**
   * A call's callee as its dotted parts and whether it was called through (`test.each(t)`), or
   * null when it is not a plain chain of names.
   *
   * @param {SyntaxNodeLike} callee @returns {string[] | null}
   */
  const parts = (callee) => {
    if (callee.name === 'VariableName') return [src(callee)];
    if (callee.name === 'CallExpression') {
      // `test.each(table)(…)`: the chain is the inner call's, ending in a called modifier.
      const inner = callee.firstChild;
      const chain = inner && parts(inner);
      return chain && chain.length > 1 ? chain : null;
    }
    if (callee.name === 'MemberExpression') {
      const object = callee.firstChild;
      const property = callee.getChild('PropertyName');
      const chain = object && parts(object);
      return chain && property ? [...chain, src(property)] : null;
    }
    return null;
  };

  /**
   * What a call is as a test call, or null when it is none.
   *
   * @param {SyntaxNodeLike} call @param {boolean} inTest
   * @returns {{kind: 'suite' | 'test', modifiers: string[]} | null}
   */
  const testCall = (call, inTest) => {
    const callee = call.firstChild;
    const chain = callee && parts(callee);
    if (!chain) return null;
    let base;
    let kind;
    if (SUITES.has(chain[0])) [base, kind] = [1, 'suite'];
    else if (TESTS.has(chain[0])) [base, kind] = [1, 'test'];
    else if (chain[0] === 'Deno' && DENO_TESTS.has(chain[1])) {
      [base, kind] = [2, 'test'];
    } else if (inTest && chain.length === 2 && chain[1] === 'step') {
      [base, kind] = [2, 'test'];
    } else return null;
    const modifiers = chain.slice(base);
    if (!modifiers.every((m) => MODIFIERS.has(m))) return null;
    return { kind: /** @type {'suite' | 'test'} */ (kind), modifiers };
  };

  /** @param {SyntaxNodeLike | null} args @returns {string} */
  const testName = (args) => {
    const first = args && argumentsOf(args)[0];
    if (!first) return '(anonymous)';
    if (first.name === 'String' || first.name === 'TemplateString') {
      return text.slice(first.from + 1, first.to - 1);
    }
    if (first.name === 'ObjectExpression') {
      for (const prop of childrenOf(first)) {
        if (prop.name !== 'Property') continue;
        const key = prop.getChild('PropertyDefinition');
        const value = prop.getChild('String');
        if (key && value && src(key) === 'name') {
          return text.slice(value.from + 1, value.to - 1);
        }
      }
    }
    if (first.name === 'FunctionExpression') {
      const name = first.getChild('VariableDefinition');
      if (name) return src(name);
    }
    return '(anonymous)';
  };

  /**
   * Searches `node` for test calls. `open` lets the walk into one function's body: a function
   * passed to a test call (directly, or as an options object's member).
   *
   * @param {SyntaxNodeLike} node @param {number} depth @param {boolean} inTest
   * @param {boolean} open
   */
  const visit = (node, depth, inTest, open) => {
    if (node.name === 'CallExpression') {
      const test = testCall(node, inTest);
      if (test) {
        const args = node.getChild('ArgList');
        push(
          test.kind,
          testName(args),
          node.from,
          node.to,
          depth,
          test.modifiers,
        );
        if (args) {
          for (const arg of childrenOf(args)) visit(arg, depth + 1, true, true);
        }
        return;
      }
    }
    if (FUNCTIONS.has(node.name) || isObjectMethod(node)) {
      if (!open) return;
      for (const child of childrenOf(node)) visit(child, depth, inTest, false);
      return;
    }
    for (const child of childrenOf(node)) visit(child, depth, inTest, open);
  };

  /** A top-level statement's declarations, then its tests. @param {SyntaxNodeLike} statement */
  const topLevel = (statement) => {
    let decl = statement;
    let isDefault = false;
    if (statement.name === 'ExportDeclaration') {
      isDefault = statement.getChild('default') !== null;
      decl = childrenOf(statement).find((c) => DECLARATIONS.has(c.name)) ??
        statement;
    }
    switch (decl.name) {
      case 'FunctionDeclaration': {
        const name = decl.getChild('VariableDefinition');
        push(
          'function',
          name ? src(name) : isDefault ? 'default' : '(anonymous)',
          decl.from,
          decl.to,
          0,
        );
        break;
      }
      case 'ClassDeclaration': {
        const name = decl.getChild('VariableDefinition');
        push(
          'class',
          name ? src(name) : isDefault ? 'default' : '(anonymous)',
          decl.from,
          decl.to,
          0,
        );
        const body = decl.getChild('ClassBody');
        for (const member of body ? childrenOf(body) : []) {
          if (member.name !== 'MethodDeclaration') continue;
          const key = member.getChild('PropertyDefinition') ??
            member.getChild('PrivatePropertyDefinition');
          if (key) push('method', src(key), member.from, member.to, 1);
        }
        break;
      }
      case 'VariableDeclaration': {
        // Each `name = function` declarator: a VariableDefinition, `=`, then its initializer.
        const kids = childrenOf(decl);
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].name !== 'VariableDefinition') continue;
          const init = kids[i + 1]?.name === 'Equals' ? kids[i + 2] : null;
          if (
            init &&
            (init.name === 'ArrowFunction' ||
              init.name === 'FunctionExpression')
          ) {
            push('function', src(kids[i]), kids[i].from, init.to, 0);
          }
        }
        break;
      }
      case 'InterfaceDeclaration':
      case 'TypeAliasDeclaration':
      case 'EnumDeclaration': {
        const name = decl.getChild('TypeDefinition');
        if (name) {
          push(
            decl.name === 'InterfaceDeclaration'
              ? 'interface'
              : decl.name === 'EnumDeclaration'
              ? 'enum'
              : 'type',
            src(name),
            decl.from,
            decl.to,
            0,
          );
        }
        break;
      }
    }
    visit(statement, 0, false, false);
  };

  try {
    for (const statement of childrenOf(tree.topNode)) topLevel(statement);
    return { items, truncated: false };
  } catch (e) {
    if (e instanceof Full) return { items, truncated: true };
    throw e;
  }
}

/** The declarations an `export` may wrap. */
const DECLARATIONS = new Set([
  'FunctionDeclaration',
  'ClassDeclaration',
  'VariableDeclaration',
  'InterfaceDeclaration',
  'TypeAliasDeclaration',
  'EnumDeclaration',
]);

/**
 * The item a cursor on `line` is in: the deepest one whose lines hold it, or null.
 *
 * @param {readonly OutlineItem[]} items @param {number} line @returns {number | null}
 */
export function currentItem(items, line) {
  let found = null;
  for (let i = 0; i < items.length; i++) {
    // In pre-order the items holding a line are a chain, parent first: the last is the deepest.
    if (items[i].line <= line && line <= items[i].endLine) found = i;
  }
  return found;
}

/** An object literal's method (`fn() {}`): a Property with its own parameter list. */
function isObjectMethod(/** @type {SyntaxNodeLike} */ node) {
  return node.name === 'Property' && node.getChild('ParamList') !== null;
}

/** @param {SyntaxNodeLike} node @returns {SyntaxNodeLike[]} */
function childrenOf(node) {
  const out = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

/** @param {SyntaxNodeLike} args @returns {SyntaxNodeLike[]} */
function argumentsOf(args) {
  return childrenOf(args).filter((c) => !NOT_ARGUMENTS.has(c.name));
}

/** A name on one line, cut to {@link MAX_OUTLINE_NAME}. @param {string} name */
function cut(name) {
  const flat = name.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_OUTLINE_NAME
    ? flat.slice(0, MAX_OUTLINE_NAME - 1) + '…'
    : flat;
}

/** Maps an offset in `text` to its 1-based line. @param {string} text */
function lineFinder(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 10) starts.push(i + 1);
    else if (ch === 13) {
      if (text.charCodeAt(i + 1) === 10) i++;
      starts.push(i + 1);
    }
  }
  return (/** @type {number} */ pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
