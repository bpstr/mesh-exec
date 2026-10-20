// Independent deterministic checks; run only against the exported result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugify } from './terra-run/task-result/slugify.mjs';

const repo = fileURLToPath(new URL('./terra-run/task-result/', import.meta.url));
test('API follows the requested normalization and separator rules', () => {
  for (const [input, expected] of [
    ['Hello, World!', 'hello-world'],
    ['Café déjà vu', 'cafe-deja-vu'],
    ['  A__B  ', 'a-b'],
    ['', ''],
    ['--- !!! ___', ''],
    ['one---two___three', 'one-two-three'],
    ['ＦＯＯ ①', 'foo-1'],
    ['e\u0301lan', 'elan'],
    ['A\u1ab0B', 'ab'],
    ['東京', ''],
  ]) assert.equal(slugify(input), expected, JSON.stringify(input));
});
test('API rejects non-string values with TypeError', () => {
  for (const value of [undefined, null, 7, false, {}, [], Symbol('x')])
    assert.throws(() => slugify(value), TypeError);
});
test('CLI joins arguments and reports missing input', () => {
  const success = spawnSync(process.execPath, ['cli.mjs', 'Café', 'déjà vu'], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  assert.equal(success.status, 0);
  assert.equal(success.stdout, 'cafe-deja-vu\n');
  assert.equal(success.stderr, '');
  const empty = spawnSync(process.execPath, ['cli.mjs'], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  assert.equal(empty.status, 1);
  assert.equal(empty.stdout, '');
  assert.match(empty.stderr, /usage/i);
});
test('Importing the API has no CLI output or exit side effect', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./slugify.mjs'); console.log('imported')"], { cwd: repo, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'imported\n');
  assert.equal(result.stderr, '');
});
