import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { codexSettings, runnerBudget } from '../src/cli.js';

test('model and effort prefer CLI, then config, then saved mission settings', () => {
  const saved = { model: 'saved-model', effort: 'high' };
  assert.deepEqual(codexSettings({}, {}, saved), saved);
  assert.deepEqual(codexSettings({}, { model: 'config-model' }, saved), {
    model: 'config-model',
    effort: 'high',
  });
  assert.deepEqual(codexSettings({ model: 'cli-model', effort: 'xhigh' }, saved), {
    model: 'cli-model',
    effort: 'xhigh',
  });
  for (const config of [{ model: 5 }, { model: '' }, { effort: true }, { effort: 'high"' }])
    assert.throws(() => codexSettings({}, config), /model must|effort must/);
});

test('linked CLI executes and reports the package version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-linked-cli-'));
  try {
    const linked = join(directory, 'mesh.ts');
    await symlink(fileURLToPath(new URL('../src/cli.ts', import.meta.url)), linked);
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--import',
      'tsx',
      linked,
      '--version',
    ]);
    assert.equal(stdout.trim(), `mesh-exec ${version}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
