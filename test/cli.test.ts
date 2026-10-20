import assert from 'node:assert/strict';
import test from 'node:test';
import { runnerBudget } from '../src/cli.js';

test('explicit timeout keeps the population running until its deadline unless a cap is supplied', () => {
  assert.deepEqual(runnerBudget({ timeout: '30m' }), {
    maxElapsedMs: 1_800_000,
    maxRuns: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(runnerBudget({ timeout: '30m', maxRuns: '12', maxMinutes: 120 }), {
    maxElapsedMs: 1_800_000,
    maxRuns: 12,
  });
  assert.deepEqual(runnerBudget({}), { maxElapsedMs: 7_200_000, maxRuns: 100 });
  assert.equal(runnerBudget({ maxMinutes: 30 }).maxElapsedMs, 1_800_000);
  for (const timeout of ['30', '1800s', '0.5h', '1800000ms'])
    assert.equal(runnerBudget({ timeout }).maxElapsedMs, 1_800_000);
});

test('invalid and overflowing timeouts fail instead of scheduling an immediate timer', () => {
  for (const timeout of ['0', '-1m', 'Infinity', '30minutes', '1d', '0.1ms', '999999999h'])
    assert.throws(() => runnerBudget({ timeout }));
  assert.throws(() => runnerBudget({ maxMinutes: 999999999 }));
});
