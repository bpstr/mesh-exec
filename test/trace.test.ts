import assert from 'node:assert/strict';
import test from 'node:test';
import { redact } from '../src/trace.js';

test('redaction preserves PostgreSQL Date values while removing nested credentials', () => {
  const at = new Date('2026-10-20T16:00:00.000Z');
  assert.deepEqual(
    redact({ started_at: at, messages: [{ created_at: at, token: 'private-token' }] }),
    {
      started_at: '2026-10-20T16:00:00.000Z',
      messages: [{ created_at: '2026-10-20T16:00:00.000Z', token: '[REDACTED]' }],
    },
  );
  assert.equal(redact(new Date('invalid')), null);
});
