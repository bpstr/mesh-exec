import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  symlink,
  appendFile,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArtifactRedactor,
  ArtifactWriter,
  copyArtifact,
  digestFile,
  verifyExport,
} from '../src/artifacts.js';
import { exportEvents, exportMission, logPath, messages } from '../src/observer.js';
import { Store } from '../src/store.js';
import { A2A_SCHEMA } from '../src/a2a.js';
import { WORKSPACE_SCHEMA } from '../src/workspace.js';
import { registerSecret } from '../src/trace.js';
import { TestDatabase } from './helpers.js';
import type { Sql, SqlResult } from '../src/types.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

test('artifact filtering preserves UTF-8 and suppresses split and unbounded credential patterns', () => {
  const secret = 'known-credential-☃-0123456789';
  const text = `start🙂 ${secret} Bearer abcdef0123456789 sk-abcdefghijklmnop postgresql://user:password@localhost/db end🙂`;
  const expected =
    'start🙂 [REDACTED] Bearer [REDACTED] [REDACTED] postgresql://user:[REDACTED]@localhost/db end🙂';
  const filter = new ArtifactRedactor([secret]);
  const bytes = Buffer.from(text);
  let output = '';
  for (let index = 0; index < bytes.length; index++)
    output += filter.write(bytes.subarray(index, index + 1));
  output += filter.end();
  assert.equal(output, expected);
  const ordinary = new ArtifactRedactor([]);
  assert.equal(
    ordinary.write('{"database":"postgres://host:5432/db"}') + ordinary.end(),
    '{"database":"postgres://host:5432/db"}',
  );

  const long = new ArtifactRedactor([]);
  output = long.write('Bearer ');
  for (let index = 0; index < 32; index++) output += long.write('x'.repeat(65536));
  output += long.write(' end postgresql://user:');
  for (let index = 0; index < 32; index++) output += long.write('y'.repeat(65536));
  output += long.write('@host/database end');
  output += long.end();
  assert.equal(output, 'Bearer [REDACTED] end postgresql://user:[REDACTED]@host/database end');
});

test('artifact copies record source/export hashes and verification rejects tampering, missing files, and archive escapes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-artifact-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'source.log');
  const secret = 'artifact-known-secret-0123456789';
  const writer = await ArtifactWriter.open(source);
  await writer.write('x'.repeat(65529) + '🙂Bearer ');
  await writer.write('very-sensitive-value\n' + secret + '\n');
  for (let index = 0; index < 32; index++) await writer.write('ordinary output🙂\n'.repeat(1024));
  await writer.finish();
  const archive = join(directory, 'archive');
  await mkdir(archive);
  const target = join(archive, 'runs', 'run-1', 'stdout.jsonl');
  const copied = await copyArtifact({ source, target, secrets: [secret] });
  assert.equal(copied.sourceSha256, (await digestFile(source)).sha256);
  assert.equal(copied.sha256, (await digestFile(target)).sha256);
  assert.equal(copied.offsetsPreserved, false);
  assert.equal(copied.partial, false);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const content = await readFile(target, 'utf8');
  assert.ok(content.includes('🙂Bearer [REDACTED]\n[REDACTED]\n'));
  assert.ok(!content.includes(secret));
  const core = [];
  for (const path of [
    'mission.json',
    'events.jsonl',
    'runs.json',
    'operations.json',
    'tasks.json',
    'messages.json',
    'a2a-messages.json',
    'outbox.json',
    'attempts.json',
    'exposures.json',
  ]) {
    await writeFile(
      join(archive, path),
      path === 'mission.json' ? '{}\n' : path.endsWith('.jsonl') ? '' : '[]\n',
    );
    core.push({ path, ...(await digestFile(join(archive, path))) });
  }
  const manifest = {
    formatVersion: 1,
    artifacts: [...core, { path: 'runs/run-1/stdout.jsonl', ...copied }],
  };
  await writeFile(join(archive, 'export.json'), JSON.stringify(manifest), { mode: 0o600 });
  assert.equal((await verifyExport(archive)).valid, true);
  await appendFile(target, 'tampered');
  const changed = await verifyExport(archive);
  assert.equal(changed.valid, false);
  assert.equal(changed.mismatched.length, 1);
  await rm(target);
  assert.deepEqual((await verifyExport(archive)).missing, ['runs/run-1/stdout.jsonl']);

  await mkdir(join(archive, 'runs', 'link-parent'));
  await symlink(directory, join(archive, 'runs', 'escaped'));
  await writeFile(
    join(archive, 'export.json'),
    JSON.stringify({
      formatVersion: 1,
      artifacts: [
        { path: '../source.log', bytes: copied.sourceBytes, sha256: copied.sourceSha256 },
        { path: 'runs/escaped/stdout.jsonl', bytes: 0, sha256: sha('') },
      ],
    }),
  );
  const unsafe = await verifyExport(archive);
  assert.equal(unsafe.valid, false);
  assert.equal(unsafe.checked, 0);
  assert.ok(unsafe.errors.some((message) => message.includes('Unsupported artifact path')));
  assert.ok(unsafe.errors.some((message) => message.includes('symlinks are not followed')));
  await writeFile(
    join(archive, 'export.json'),
    JSON.stringify({ formatVersion: 1, artifacts: [] }),
  );
  assert.equal((await verifyExport(archive)).valid, false);
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-export-test-'));
  const db = new TestDatabase();
  const store = new Store(db);
  await store.initialize();
  await db.query(A2A_SCHEMA);
  await db.query(WORKSPACE_SCHEMA);
  const mission = await store.createMission({
    repo: directory,
    roadmapPath: join(directory, 'ROADMAP.md'),
    roadmapText: 'Keep every observable record.',
    baseline: {},
    agents: 2,
  });
  return {
    directory,
    db,
    store,
    mission,
    close: async () => {
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('event export pages beyond 2000 records and excludes events committed after its captured cursor', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO trace_events(id,mission_id,seq,kind,data)
      SELECT 'event-'||g,$1,g,'example.output',jsonb_build_object('ordinal',g) FROM generate_series(2,2065) g`,
      [f.mission.id],
    );
    await tx.query('UPDATE missions SET next_event_seq=2065 WHERE id=$1', [f.mission.id]);
  });
  let inserted = false;
  const observed: Sql = {
    query: async <R>(sql: string, values?: unknown[]): Promise<SqlResult<R>> => {
      const result = await f.db.query<R>(sql, values);
      if (!inserted && sql.includes('FROM trace_events')) {
        inserted = true;
        await f.store.events({
          missionId: f.mission.id,
          kind: 'late.output',
          data: { text: 'arrived after capture' },
        });
      }
      return result;
    },
  };
  const path = join(f.directory, 'events.jsonl');
  const exported = await exportEvents(observed, f.mission.id, path);
  assert.equal(exported.events, 2065);
  assert.equal(exported.upperEventSeq, '2065');
  assert.equal(exported.lastEventSeq, '2065');
  const records = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2065);
  assert.equal(new Set(records.map((item) => item.seq)).size, 2065);
  assert.ok(records.every((item) => item.kind !== 'late.output'));
  assert.equal((await digestFile(path)).sha256, exported.sha256);
});

test('mission export retains paged run history, active command logs, complete conversation state, and capture integrity', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const runDirectory = join(f.directory, 'run-01');
  await mkdir(runDirectory);
  const secret = 'export-known-credential-0123456789';
  registerSecret(secret);
  const stdout = `visible🙂 ${secret}\n` + 'line🙂\n'.repeat(20000);
  const runFiles: Record<string, string> = {
    'stdout.jsonl': stdout,
    'stderr.log': 'diagnostic\n',
    'events.jsonl': '{"kind":"example"}\n',
    'result.json': '{"outcome":"progress","summary":"final run output"}\n',
    'prompt.txt': 'Implement the roadmap.\n',
    'result.schema.json': '{"type":"object"}\n',
  };
  for (const [name, content] of Object.entries(runFiles))
    await writeFile(join(runDirectory, name), content);
  const capture = (name: string) => ({
    path: join(runDirectory, name),
    bytes: Buffer.byteLength(runFiles[name]),
    sha256: sha(runFiles[name]),
    synced: true,
    eof: true,
    indexComplete: true,
    failures: [],
  });
  await writeFile(
    join(runDirectory, 'capture.json'),
    JSON.stringify({
      schemaVersion: 1,
      status: 'complete',
      stdout: capture('stdout.jsonl'),
      stderr: capture('stderr.log'),
      prompt: capture('prompt.txt'),
      schema: capture('result.schema.json'),
      result: { ...capture('result.json'), status: 'valid' },
    }),
  );
  await f.db.query(
    `INSERT INTO runs(id,mission_id,agent_id,generation,supervisor_epoch,token_hash,lease_expires,state,started_at,log_dir,result)
    SELECT 'run-'||lpad(g::text,2,'0'),$1,'A1',g,1,'hash-'||g,now(),'exited','2026-01-01T00:00:00Z',CASE WHEN g=1 THEN $2 ELSE NULL END,jsonb_build_object('summary','handoff-'||g) FROM generate_series(1,43) g`,
    [f.mission.id, runDirectory],
  );
  const commandDirectory = join(f.directory, 'active-command');
  const outputs = join(commandDirectory, 'outputs');
  await mkdir(outputs, { recursive: true });
  await writeFile(join(commandDirectory, 'stdout.log'), 'still running output🙂\n');
  await writeFile(join(commandDirectory, 'stderr.log'), '');
  await f.db.query(
    `INSERT INTO workspace_operations(mission_id,operation_id,repo_id,agent_id,run_id,generation,kind,request_hash,state,request,journal)
    VALUES($1,'live-command','test','A1','run-01',1,'command','hash','running','{}',$2::jsonb)`,
    [f.mission.id, JSON.stringify({ outputDirectory: outputs })],
  );
  assert.equal(
    await logPath(f.db, f.mission.id, { operation: 'live-command' }),
    join(commandDirectory, 'stdout.log'),
  );
  await assert.rejects(messages(f.db, f.mission.id, { limit: Number.NaN }), /positive integer/u);
  await f.db.query(
    `INSERT INTO a2a_tasks(task_id,mission_id,recipient_id,sender_id,context_id,state,task,trace_id) VALUES('task-1',$1,'A2','A1','context',1,'{}','trace-1')`,
    [f.mission.id],
  );
  await f.db.query(
    `INSERT INTO mailbox_deliveries(delivery_id,mission_id,sender_id,recipient_id,message_id,task_id,message,kind,trace_id)
    VALUES('delivery-1',$1,'A1','A2','accepted-message','task-1','{"text":"complete delivered message"}','question','trace-1')`,
    [f.mission.id],
  );
  await f.db.query(
    `INSERT INTO mailbox_offers(delivery_id,run_id) VALUES('delivery-1','run-01'),('delivery-1','run-02')`,
  );
  await f.db.query(
    `INSERT INTO a2a_messages(mission_id,sender_id,recipient_id,message_id,task_id,run_id,generation,payload_hash,message,accepted_result,kind,trace_id)
    VALUES($1,'A1','A2','accepted-message','task-1','run-01',1,'hash','{"text":"complete delivered message"}','{}','question','trace-1')`,
    [f.mission.id],
  );
  await f.db.query(
    `INSERT INTO a2a_outbox(outbox_id,mission_id,sender_id,recipient_id,message_id,principal,request,payload_hash,trace_id)
    VALUES('outbox-1',$1,'A1','A2','pending-message','{}','{"text":"complete undelivered message"}','hash','trace-2')`,
    [f.mission.id],
  );
  await f.db.query(
    `INSERT INTO a2a_outbox_attempts(attempt_id,outbox_id,error) VALUES('attempt-1','outbox-1','{"message":"transient retry"}')`,
  );

  const directory = join(f.directory, 'export');
  const exported = (await exportMission(f.db, f.mission.id, directory)) as Record<string, any>;
  const manifest = JSON.parse(await readFile(join(directory, 'export.json'), 'utf8'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.upperEventSeq, exported.upperEventSeq);
  const runs = JSON.parse(await readFile(join(directory, 'runs.json'), 'utf8'));
  assert.equal(runs.length, 43);
  assert.equal(new Set(runs.map((item: any) => item.id)).size, 43);
  assert.equal(runs[0].started_at, '2026-01-01T00:00:00.000Z');
  assert.ok(runs.some((item: any) => item.result.summary === 'handoff-43'));
  assert.match(
    await readFile(join(directory, 'outbox.json'), 'utf8'),
    /complete undelivered message/u,
  );
  assert.match(await readFile(join(directory, 'attempts.json'), 'utf8'), /transient retry/u);
  assert.equal(JSON.parse(await readFile(join(directory, 'exposures.json'), 'utf8')).length, 2);
  assert.match(await readFile(join(directory, 'a2a-messages.json'), 'utf8'), /run-01/u);
  const command = manifest.artifacts.find(
    (item: any) => item.operationId === 'live-command' && item.path.endsWith('stdout.log'),
  );
  assert.equal(await readFile(join(directory, command.path), 'utf8'), 'still running output🙂\n');
  assert.equal(command.partial, true);
  const run = manifest.artifacts.find(
    (item: any) => item.runId === 'run-01' && item.path.endsWith('stdout.jsonl'),
  );
  assert.equal(run.sourceSha256, sha(stdout));
  assert.equal(run.integrity, 'verified');
  assert.equal(run.offsetsPreserved, false);
  assert.ok(!(await readFile(join(directory, run.path), 'utf8')).includes(secret));
  assert.ok(manifest.missing.some((item: any) => item.runId === 'run-43'));
  const verified = await verifyExport(directory);
  assert.equal(verified.valid, true, JSON.stringify(verified));
  assert.equal(verified.partial, true);
});
