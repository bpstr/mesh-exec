import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { slugify } from './slugify.mjs';

test('slugifies the documented examples', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('  A__B  '), 'a-b');
});

test('returns empty strings for empty and punctuation-only input', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify('!? — _'), '');
});

test('collapses repeated separators and trims their edges', () => {
  assert.equal(slugify('---one___two...three---'), 'one-two-three');
});

test('rejects non-string input', () => {
  for (const value of [null, undefined, 42, {}, []]) {
    assert.throws(() => slugify(value), TypeError);
  }
});

test('CLI prints the slug for its arguments', () => {
  const result = spawnSync(process.execPath, ['cli.mjs', 'Café', 'déjà', 'vu'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'cafe-deja-vu\n');
  assert.equal(result.stderr, '');
});

test('CLI reports usage and fails without arguments', () => {
  const result = spawnSync(process.execPath, ['cli.mjs'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /usage/i);
});
