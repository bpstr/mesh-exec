import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugify } from './slugify.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

for (const [input, expected] of [
  ['Hello, World!', 'hello-world'],
  ['Café déjà vu', 'cafe-deja-vu'],
  ['  A__B  ', 'a-b'],
  ['', ''],
  ['!? -- ___', ''],
  ['a___---   b...c', 'a-b-c'],
  ['Cafe\u0301', 'cafe'],
  ['Ｆｏｏ １２３', 'foo-123'],
]) {
  test(`slugify ${JSON.stringify(input)}`, () => {
    assert.equal(slugify(input), expected);
  });
}

test('rejects non-string values', () => {
  for (const value of [undefined, null, 42, true, {}, [], new String('hello')]) {
    assert.throws(() => slugify(value), TypeError);
  }
});

test('CLI joins arguments and prints one newline', () => {
  const result = spawnSync(process.execPath, [cli, 'Hello,', 'World!'], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'hello-world\n');
  assert.equal(result.stderr, '');
});

test('CLI without arguments reports usage and exits 1', () => {
  const result = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage/i);
});

test('importing the API has no CLI side effects', () => {
  const moduleUrl = new URL('./slugify.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`], { encoding: 'utf8' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
