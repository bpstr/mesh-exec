import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildCodexInvocation,
  codexEnvironment,
  CodexEventTracker,
  parseCodexRunResult,
  preflightCodex,
  prepareCodexRunFiles,
  StreamingRedactor,
} from '../src/codex.js';

test('native Codex correlation carries observed thread and turn IDs without inventing them', () => {
  const tracker = new CodexEventTracker();
  assert.deepEqual(tracker.observe({ type: 'turn.started' }), {});
  assert.deepEqual(tracker.observe({ type: 'thread.started', thread_id: 'thread-1' }), {
    threadId: 'thread-1',
  });
  assert.deepEqual(tracker.observe({ type: 'turn.started', turn_id: 'turn-1' }), {
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  assert.deepEqual(tracker.observe({ type: 'item.completed', item: { id: 'item-7' } }), {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-7',
  });
  assert.deepEqual(tracker.observe({ type: 'turn.completed' }), {
    threadId: 'thread-1',
    turnId: 'turn-1',
  });
  assert.deepEqual(tracker.observe({ type: 'turn.started' }), { threadId: 'thread-1' });
  assert.deepEqual(tracker.observe({ type: 'thread.started', thread_id: 'thread-2' }), {
    threadId: 'thread-2',
  });
});

test('fresh Codex invocation isolates config, preserves auth, and uses one initial prompt', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mesh-codex-'));
  try {
    const invocation = buildCodexInvocation({
      repository: join(temporary, 'repo.with dots'),
      roadmapPath: 'ROADMAP.md',
      missionId: 'mission',
      slotId: 'A2',
      runId: 'run-2',
      generation: 2,
      runDirectory: join(temporary, 'run'),
      mcpUrl: 'http://127.0.0.1:9010/mcp',
      runToken: 'per-run-credential-do-not-log',
      environment: { CODEX_HOME: '/chosen/auth', PATH: process.env.PATH },
    });
    const args = invocation.args;
    assert.equal(args[0], 'exec');
    assert.equal(args.at(-1), '-');
    for (const flag of [
      '--ignore-user-config',
      '--strict-config',
      '--json',
      '--output-schema',
      '--output-last-message',
    ])
      assert.ok(args.includes(flag));
    for (const forbidden of [
      '--profile',
      '--worktree',
      'resume',
      '--full-auto',
      '--dangerously-bypass-approvals-and-sandbox',
    ])
      assert.ok(!args.includes(forbidden));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    for (const feature of ['multi_agent', 'apps', 'plugins', 'hooks', 'memories'])
      assert.ok(args.includes(`features.${feature}=false`));
    assert.ok(
      args.includes(`projects={${JSON.stringify(invocation.cwd)}={trust_level="untrusted"}}`),
    );
    assert.ok(args.includes('mcp_servers.mesh.required=true'));
    assert.ok(!JSON.stringify(args).includes(invocation.env.MESH_RUN_TOKEN!));
    assert.equal(invocation.env.CODEX_HOME, '/chosen/auth');
    assert.equal(invocation.env.MESH_RUN_GENERATION, '2');
    assert.match(invocation.prompt, /mesh_poll/u);
    assert.match(invocation.prompt, /workRevision/u);
    await prepareCodexRunFiles(invocation, join(temporary, 'run'));
    assert.equal(await readFile(invocation.promptPath, 'utf8'), `${invocation.prompt}\n`);
    assert.ok(
      JSON.parse(await readFile(invocation.schemaPath, 'utf8')).required.includes('work_revision'),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('streaming redaction handles every split position, Unicode, escaped and overlapping secrets', () => {
  const secrets = ['credential-12345', 'credential-123', 'quoted"\nsecret'];
  const raw = 'α🙂credential-12345/credential-123/quoted"\nsecret/quoted\\"\\nsecret/終';
  const expected = 'α🙂[REDACTED]/[REDACTED]/[REDACTED]/[REDACTED]/終';
  const bytes = Buffer.from(raw);
  for (let split = 0; split <= bytes.length; split++) {
    const redactor = new StreamingRedactor(secrets);
    assert.equal(
      redactor.write(bytes.subarray(0, split)) +
        redactor.write(bytes.subarray(split)) +
        redactor.end(),
      expected,
      `split ${split}`,
    );
  }
  const oneByte = new StreamingRedactor(secrets);
  assert.equal(
    [...bytes].map((byte) => oneByte.write(Buffer.from([byte]))).join('') + oneByte.end(),
    expected,
  );
  assert.equal(oneByte.end(), '');
  assert.throws(() => oneByte.write('again'));
});

test('worker environment excludes daemon credentials and schema parsing rejects malformed handoffs', () => {
  const environment = codexEnvironment({
    PATH: '/bin',
    HOME: '/home/a',
    OPENAI_API_KEY: 'chosen-key',
    MESH_OBSERVER_TOKEN: 'admin',
    DATABASE_URL: 'postgres://secret',
    LC_ALL: 'C',
  });
  assert.deepEqual(environment, {
    PATH: '/bin',
    HOME: '/home/a',
    OPENAI_API_KEY: 'chosen-key',
    LC_ALL: 'C',
  });
  const valid = {
    outcome: 'idle',
    summary: 'Waiting',
    checkpoint_id: null,
    waiting_on: ['decision'],
    work_revision: '7',
  };
  assert.deepEqual(parseCodexRunResult(valid), valid);
  assert.throws(() => parseCodexRunResult({ ...valid, work_revision: undefined }));
  assert.throws(() => parseCodexRunResult({ ...valid, rogue: true }));
});

test('CLI qualification checks installed help before any model run and rejects missing flags', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'mesh-qualify-'));
  const binary = join(temporary, 'codex');
  try {
    const source = (flags: string) =>
      `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex-cli 0.134.0');else if(process.argv.includes('--help'))console.log(${JSON.stringify(flags)});else process.exit(99);\n`;
    await writeFile(
      binary,
      source(
        '--ignore-user-config --cd --sandbox --ephemeral --json --output-schema --output-last-message --strict-config',
      ),
    );
    await chmod(binary, 0o700);
    assert.equal((await preflightCodex({ codexBinary: binary })).version, 'codex-cli 0.134.0');
    await writeFile(binary, source('--json --sandbox'));
    await assert.rejects(
      preflightCodex({ codexBinary: binary }),
      /lacks required flags.*--ignore-user-config/u,
    );
    await assert.rejects(
      preflightCodex({ codexBinary: join(temporary, 'absent') }),
      /qualification ENOENT/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
