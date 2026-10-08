import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import postcssConfig from '../frontend/postcss.config.js';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const fromFrontend = createRequire(new URL('../frontend/package.json', import.meta.url));
const postcss = fromFrontend('postcss');
const autoprefixer = fromFrontend('autoprefixer');

function configuredPlugins() {
  return Object.entries(postcssConfig.plugins).map(([name, options]) => {
    const loaded = fromFrontend(name);
    return (loaded.default ?? loaded)(options);
  });
}

// Ignore comments and source locations, but preserve every selector, declaration,
// at-rule, order and nesting boundary that can affect the existing interface.
function styleContract(root) {
  const entries = [];
  const visit = container => {
    for (const node of container.nodes ?? []) {
      if (node.type === 'comment') continue;
      if (node.type === 'decl') {
        entries.push(JSON.stringify(['decl', node.prop, node.value, Boolean(node.important)]));
      } else {
        entries.push(JSON.stringify(node.type === 'rule'
          ? ['rule', node.selector] : [node.type, node.name, node.params]));
        if (node.nodes) {
          visit(node);
          entries.push('end');
        }
      }
    }
  };
  visit(root);
  return entries;
}

const existingStyles = [
  ['monitor and admin', join(frontend, 'src/index.css')],
  ['Radix components', fromFrontend.resolve('@radix-ui/themes/styles.css')],
];
for (const [label, file] of existingStyles) {
  test('Tailwind 4 preserves ' + label + ' CSS without injecting a reset', { timeout: 30000 }, async () => {
    const source = await readFile(file, 'utf8');
    // The existing files have no Tailwind directives. Their effective old
    // transformation was autoprefixer; use that independent baseline.
    const expected = await postcss([autoprefixer(postcssConfig.plugins.autoprefixer)]).process(source, { from: file });
    const actual = await postcss(configuredPlugins()).process(source, { from: file });
    const before = styleContract(expected.root);
    const after = styleContract(actual.root);
    for (let i = 0; i < Math.min(before.length, after.length); i++) {
      assert.equal(after[i], before[i], label + ' CSS contract entry ' + i);
    }
    assert.equal(after.length, before.length, label + ' must not gain or lose style rules');
  });
}

test('the configured Tailwind 4 adapter compiles explicitly opted-in utilities', { timeout: 30000 }, async () => {
  const source = '@import "tailwindcss" source(none);\n@source inline("p-4");\n';
  const result = await postcss(configuredPlugins()).process(source, {
    from: join(frontend, 'test/tailwind-utilities-fixture.css'),
  });
  let padding;
  let spacing;
  result.root.walkRules('.p-4', rule => rule.walkDecls('padding', declaration => { padding = declaration.value; }));
  result.root.walkDecls('--spacing', declaration => { spacing = declaration.value; });
  assert.equal(padding?.replace(/\s+/g, ''), 'calc(var(--spacing)*4)');
  assert.equal(Number.parseFloat(spacing), 0.25);
  assert.ok(spacing.endsWith('rem'), 'the standard p-4 utility retains its one-rem spacing');
});
