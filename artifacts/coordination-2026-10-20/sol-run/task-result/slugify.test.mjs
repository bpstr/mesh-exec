import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugify } from './slugify.mjs';

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));

for (const [input, expected] of [
  ['Hello, World!', 'hello-world'],
  ['Café déjà vu', 'cafe-deja-vu'],
  ['  A__B  ', 'a-b'],
  ['', ''],
  ['!? — ___', ''],
  ['---one___two   three---', 'one-two-three'],
  ['Cafe\u0301', 'cafe'],
  ['Ｆｏｏ ①', 'foo-1'],
]) {
  test(`slugify ${JSON.stringify(input)}`, () => {
    assert.equal(slugify(input), expected);
  });
}

test('rejects non-string values', () => {
  for (const value of [undefined, null, 1, true, {}, [], new String('hello')]) {
    assert.throws(() => slugify(value), TypeError);
  }
});

test('CLI joins all arguments and prints one newline', () => {
  const result = spawnSync(process.execPath, [cliPath, 'Café', 'déjà', 'vu!'], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'cafe-deja-vu\n');
  assert.equal(result.stderr, '');
});

test('CLI rejects missing arguments with usage on stderr', () => {
  const result = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage/i);
});

test('importing the API has no CLI side effects', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('./slugify.mjs', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
