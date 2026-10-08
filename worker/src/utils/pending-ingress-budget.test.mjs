import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingIngressBudget } from './pending-ingress-budget.ts';

const limits = { perClientMessages: 2, perClientBytes: 10, globalMessages: 3, globalBytes: 20 };
test('pending ingress: client count/byte and global count/byte limits are independent', () => {
  const budget = new PendingIngressBudget(limits);
  const a = budget.tryReserve('a', 6);
  assert.ok(a);
  assert.equal(budget.tryReserve('a', 5), null);
  const b = budget.tryReserve('a', 4);
  assert.ok(b);
  assert.equal(budget.tryReserve('a', 0), null);
  const c = budget.tryReserve('b', 10);
  assert.ok(c);
  assert.equal(budget.tryReserve('c', 1), null);
  b.release();
  assert.equal(budget.tryReserve('c', 5), null, 'global bytes still bind');
  const d = budget.tryReserve('c', 4);
  assert.ok(d);
  assert.deepEqual(budget.snapshot(), { messages: 3, bytes: 20, clients: 3 });
  for (const lease of [a, c, d]) lease.release();
  assert.deepEqual(budget.snapshot(), { messages: 0, bytes: 0, clients: 0 });
});
test('pending ingress: release is idempotent and reconnecting UUID cannot reset a live reservation', () => {
  const budget = new PendingIngressBudget({ ...limits, perClientMessages: 1 });
  const old = budget.tryReserve('same-uuid', 3);
  assert.equal(budget.tryReserve('same-uuid', 1), null);
  old.release();
  const current = budget.tryReserve('same-uuid', 2);
  old.release();
  assert.deepEqual(budget.snapshot(), { messages: 1, bytes: 2, clients: 1 });
  current.release();
});
test('pending ingress: invalid values never become unbounded budgets or negative reservations', () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    assert.throws(() => new PendingIngressBudget({ globalBytes: value }));
  }
  const budget = new PendingIngressBudget(limits);
  for (const bytes of [-1, NaN, Infinity, 1.5]) assert.equal(budget.tryReserve('a', bytes), null);
  assert.equal(budget.tryReserve('', 1), null);
  assert.deepEqual(budget.snapshot(), { messages: 0, bytes: 0, clients: 0 });
});
