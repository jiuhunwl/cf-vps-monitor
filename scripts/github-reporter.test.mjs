import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { formatFailure } from './github-reporter.mjs';

const root = resolve('synthetic-repository');
const event = overrides => ({ type: 'test:fail', data: {
  file: join(root, 'worker/test/example.test.mjs'), line: 42, column: 3,
  name: 'synthetic public test', details: { error: { code: 'ERR_TEST_FAILURE',
    cause: { code: 'ERR_ASSERTION', message: 'PRIVATE_ERROR_VALUE', actual: 'PRIVATE_ASSERTION_VALUE' } } },
  ...overrides,
} });

test('GitHub reporter limits annotations to location, name and known error code', () => {
  const output = formatFailure(event({}), root);
  assert.equal(output, '::error file=worker/test/example.test.mjs,line=42,col=3,title=Node.js test failure::synthetic public test [ERR_ASSERTION]\n');
  assert.ok(!output.includes('PRIVATE_'));
});

test('GitHub reporter escapes command delimiters and ignores private or external locations', () => {
  const output = formatFailure(event({ file: join(root, 'comma,name.test.mjs'), name: 'name%\r\n::warning::not a command' }), root);
  assert.ok(output.includes('file=comma%2Cname.test.mjs'));
  assert.ok(output.includes('name%25%0D%0A::warning::not a command'));
  assert.equal(output.split('\n').length, 2);
  for (const file of [join(root, '..', 'outside.test.mjs'), join(root, '.git', 'private'), join(root, 'node_modules', 'dependency.test.mjs')]) {
    assert.equal(formatFailure(event({ file }), root), '');
  }
  assert.equal(formatFailure({ type: 'test:pass', data: event({}).data }, root), '');
  assert.equal(formatFailure({ type: 'test:fail', data: {} }, root), '');
});

for (const fails of [false, true]) {
  test('GitHub reporter preserves the Node test exit code for a ' + (fails ? 'failure' : 'pass'), t => {
    const base = realpathSync(tmpdir());
    const dir = mkdtempSync(join(base, 'cf-vps-reporter-'));
    t.after(() => {
      const target = realpathSync(dir);
      assert.equal(dirname(target), base);
      assert.ok(basename(target).startsWith('cf-vps-reporter-'));
      rmSync(target, { recursive: true });
    });
    const file = join(dir, 'fixture.test.mjs');
    writeFileSync(file, "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('synthetic reporter fixture', () => assert.equal(1, " + (fails ? '2' : '1') + ", 'PRIVATE_ASSERTION_VALUE'));\n");
    const reporter = new URL('./github-reporter.mjs', import.meta.url).href;
    const env = { GITHUB_ACTIONS: 'true', HOME: dir, USERPROFILE: dir, TMPDIR: dir, TEMP: dir, TMP: dir };
    for (const key of ['SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    const result = spawnSync(process.execPath, [
      '--test', '--test-reporter=spec', '--test-reporter=' + reporter,
      '--test-reporter-destination=stdout', '--test-reporter-destination=stdout', file,
    ], { cwd: dir, env, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined, 'the real Node runner must execute');
    assert.equal(result.status, fails ? 1 : 0);
    const annotations = result.stdout.split(/\r?\n/).filter(line => line.startsWith('::error '));
    if (fails) {
      assert.ok(annotations.some(line => line.includes('synthetic reporter fixture')));
      assert.ok(annotations.every(line => !line.includes('PRIVATE_ASSERTION_VALUE')));
    } else {
      assert.deepEqual(annotations, []);
    }
  });
}
