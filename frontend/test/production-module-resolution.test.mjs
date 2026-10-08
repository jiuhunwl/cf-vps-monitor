import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateProductionExpression } from './helpers/production-module.mjs';

test('shared frontend loader compiles TypeScript through the declared compiler dependency', () => {
  const increment = evaluateProductionExpression('(value: number): number => value + 1');
  assert.equal(increment(2), 3);
});

test('shared frontend loader resolves the real React JSX runtime from the frontend package', () => {
  const element = evaluateProductionExpression('<span data-fixture="declared-runtime">ok</span>');
  assert.equal(element.type, 'span');
  assert.equal(element.props['data-fixture'], 'declared-runtime');
  assert.equal(element.props.children, 'ok');
});
