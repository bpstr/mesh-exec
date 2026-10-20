import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../src/daemon.js';
import { TestDatabase } from './helpers.js';
import { exportMission, messages, metrics } from '../src/observer.js';
import { readEvents } from '../src/trace.js';
const exec = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mesh-integration-'));
  const repo = join(directory, 'repo');
  await mkdir(repo);
  await writeFile(
    join(repo, 'ROADMAP.md'),
    '# Counter\nImplement a counter that starts at zero.\n',
  );
  await exec('git', ['init', '-q', repo]);
  const db = new TestDatabase();
  // This test exercises protocol/DB/filesystem integration. Production never
  // receives this deliberately unconfined process adapter; sandbox tests own it.
  const daemon = await startDaemon({
    db,
    repo,
    runtimeDir: join(directory, 'runtime'),
    roadmapPath: 'ROADMAP.md',
    agents: 2,
    port: 0,
    workspace: {
      commandBuilder: async (o) => ({
        command: o.argv[0],
        args: o.argv.slice(1),
        cwd: o.cwd ?? o.repo,
        env: { ...process.env, ...o.env },
        detached: true,
      }),
    },
  });
  const { epoch } = await daemon.store.acquireSupervisor({
    missionId: daemon.missionId,
    supervisorId: 'integration',
    pid: process.pid,
    hostname: 'test',
    leaseMs: 120_000,
  });
  const a = await daemon.store.allocateRun({
    missionId: daemon.missionId,
    agentId: 'A1',
    supervisorId: 'integration',
    epoch,
  });
  const b = await daemon.store.allocateRun({
    missionId: daemon.missionId,
    agentId: 'A2',
    supervisorId: 'integration',
    epoch,
  });
  const connect = async (token: string) => {
    const client = new Client({ name: 'independent-mcp-client', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(daemon.url + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  };
  const [ca, cb] = await Promise.all([connect(a.token), connect(b.token)]);
  const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as { text?: string }[];
    const result = JSON.parse(content[0].text!);
    if (r.isError) throw new Error(`${result.code}: ${result.error}`);
    return result;
  };
  return {
    directory,
    repo,
    db,
    daemon,
    a,
    b,
    ca,
    cb,
    call,
    close: async () => {
      await ca.close();
      await cb.close();
      await daemon.close();
      await db.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('independent MCP peers consult over A2A, publish in one checkout, and complete with a traced final barrier', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const unauth = await fetch(f.daemon.url + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert.equal(unauth.status, 401);
  const available = await f.ca.listTools();
  assert.ok(available.tools.some((t) => t.name === 'mesh_cancel'));
  const joined = await f.call(f.ca, 'mesh_join');
  assert.equal(joined.identity.agentId, 'A1');
  assert.match(joined.roadmap.text, /counter/);
  await f.call(f.ca, 'mesh_claim', {
    id: 'claim-counter',
    resources: ['counter.txt'],
    description: 'Implement counter',
    intentionId: 'implement-counter',
  });
  const conflict = await f.call(f.cb, 'mesh_claim', {
    id: 'conflict',
    resources: ['counter.txt'],
    description: 'Review counter',
  });
  assert.equal(conflict.granted, false);
  const request = await f.call(f.ca, 'mesh_send', {
    recipientId: 'A2',
    messageId: 'question-1',
    text: 'Should zero be represented as "0"?\nPlease inspect the roadmap.',
    kind: 'question',
  });
  const incoming = await f.call(f.cb, 'mesh_poll');
  assert.equal(incoming.messages.length, 1);
  await f.call(f.cb, 'mesh_reply', {
    taskId: request.taskId,
    messageId: 'answer-1',
    text: 'Yes. The roadmap says starts at zero.\nUse 0 with a newline.',
    state: 'completed',
  });
  await f.call(f.cb, 'mesh_ack', {
    deliveryId: incoming.messages[0].deliveryId,
    disposition: 'handled',
  });
  const answer = await f.call(f.ca, 'mesh_poll');
  await f.call(f.ca, 'mesh_ack', {
    deliveryId: answer.messages[0].deliveryId,
    disposition: 'handled',
  });
  const applied = await f.call(f.ca, 'mesh_patch', {
    operationId: 'write-counter',
    claimId: 'claim-counter',
    changes: [{ path: 'counter.txt', expectedHash: null, content: '0\n' }],
  });
  assert.equal(applied.state, 'applied');
  assert.equal(await readFile(join(f.repo, 'counter.txt'), 'utf8'), '0\n');
  const source = await f.call(f.ca, 'mesh_read', { paths: ['counter.txt'], manifest: true });
  await f.call(f.ca, 'mesh_requirement', {
    id: 'R1',
    anchor: 'Implement a counter that starts at zero.',
    title: 'Initial counter',
    criteria: ['Counter file contains zero and a newline'],
    state: 'implemented',
    evidence: [
      {
        criterion: 0,
        description: 'Inspected counter.txt after guarded publication',
        files: { 'counter.txt': source.files[0].hash },
      },
    ],
  });
  await f.call(f.cb, 'mesh_review', {
    id: 'review-r1',
    kind: 'requirement',
    targetId: 'R1',
    targetRevision: 1,
    manifestHash: source.manifest.hash,
    verdict: 'pass',
    reasoning: 'The file represents the required initial zero value.',
  });
  await f.call(f.cb, 'mesh_review', {
    id: 'review-coverage',
    kind: 'coverage',
    manifestHash: source.manifest.hash,
    verdict: 'pass',
    reasoning: 'Compared the original roadmap to R1; no requirement is omitted.',
  });
  await f.call(f.ca, 'mesh_yield', { reason: 'Implementation ready for final verification' });
  const proposal = await f.call(f.ca, 'mesh_propose_completion', {
    operationId: 'finish-1',
    checks: [
      [
        process.execPath,
        '-e',
        `const fs=require('node:fs'); if(fs.readFileSync('counter.txt','utf8')!=='0\\n') process.exit(1); console.log('counter accepted');`,
      ],
    ],
  });
  assert.equal(proposal.state, 'accepted');
  await f.daemon.completion.close();
  const mission = await f.daemon.store.mission(f.daemon.missionId);
  assert.equal(
    mission.state,
    'completed',
    JSON.stringify(await f.daemon.completion.status(mission.id, 'finish-1')),
  );
  const events = await readEvents(f.db, mission.id, { limit: 2000 });
  assert.ok(events.some((e) => e.kind === 'mission.completed'));
  assert.ok(events.some((e) => e.kind === 'completion.proposal.completed'));
  assert.ok(events.some((e) => e.kind === 'message.offered'));
  assert.ok(!JSON.stringify(events).includes(f.a.token));
  const conversation = await messages(f.db, mission.id, { task: request.taskId });
  assert.equal(conversation.length, 2);
  assert.ok(conversation.every((d: any) => d.handled_at));
  assert.match(await metrics(f.db, mission.id), /mesh_messages_pending\{[^}]+\} 0/);
  const exportDir = join(f.directory, 'export');
  const exported = (await exportMission(f.db, mission.id, exportDir)) as { events: number };
  assert.ok(exported.events > 20);
  const snapshot = JSON.parse(await readFile(join(exportDir, 'mission.json'), 'utf8'));
  assert.match(snapshot.mission.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(
    await readFile(join(exportDir, 'events.jsonl'), 'utf8'),
    /Should zero be represented/,
  );
  assert.match(await readFile(join(exportDir, 'messages.json'), 'utf8'), /starts at zero/);
});

test('completion refuses stale coverage, unhandled replies, and a changing validation source', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const manifest = await f.daemon.workspace.manifest();
  await f.daemon.store.requirement(f.a.principal, {
    id: 'R1',
    anchor: 'Implement a counter',
    title: 'Counter',
    criteria: ['done'],
    state: 'implemented',
    evidence: [{ criterion: 0, description: 'Manual evidence' }],
  });
  await f.daemon.store.review(f.b.principal, {
    id: 'coverage-old',
    kind: 'coverage',
    manifestHash: manifest.hash,
    verdict: 'pass',
    reasoning: 'One requirement',
  });
  await f.daemon.store.requirement(f.a.principal, {
    id: 'R1',
    anchor: 'Implement a counter',
    title: 'Counter',
    criteria: ['done'],
    state: 'implemented',
    expectedRevision: 1,
    evidence: [{ criterion: 0, description: 'Revised manual evidence' }],
  });
  await f.daemon.store.review(f.b.principal, {
    id: 'r1-new',
    kind: 'requirement',
    targetId: 'R1',
    targetRevision: 2,
    manifestHash: manifest.hash,
    verdict: 'pass',
    reasoning: 'Current criteria checked',
  });
  const checks = [[process.execPath, '-e', 'console.log("checked")']];
  await assert.rejects(
    f.daemon.completion.propose(f.a.principal, { operationId: 'stale-coverage', checks }),
    /different peer must review coverage/,
  );
  await f.daemon.store.review(f.b.principal, {
    id: 'coverage-current',
    kind: 'coverage',
    manifestHash: manifest.hash,
    verdict: 'pass',
    reasoning: 'Compared the revised ledger to the roadmap',
  });
  const q = await f.daemon.a2a.send(f.a.principal, {
    recipientId: 'A2',
    messageId: 'question',
    text: 'Any final correction?',
  });
  const received = await f.daemon.a2a.poll(f.b.principal);
  await f.daemon.a2a.ack(f.b.principal, { deliveryId: received.messages[0].deliveryId });
  await f.daemon.a2a.reply(f.b.principal, {
    taskId: q.taskId!,
    messageId: 'reply',
    text: 'Review this qualification.',
  });
  await assert.rejects(
    f.daemon.completion.propose(f.a.principal, { operationId: 'unhandled', checks }),
    /handle pending replies/,
  );
  const reply = await f.daemon.a2a.poll(f.a.principal);
  await f.daemon.a2a.ack(f.a.principal, { deliveryId: reply.messages[0].deliveryId });
  await assert.rejects(
    f.daemon.completion.propose(f.a.principal, {
      operationId: 'source-change',
      checks: [
        [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync('external-change.txt','changed')`,
        ],
      ],
    }),
    /Source changed/,
  );
  assert.equal((await f.daemon.store.mission(f.daemon.missionId)).state, 'active');
  assert.ok(
    (await readEvents(f.db, f.daemon.missionId, { kind: 'completion.reopened' })).length > 0,
  );
});
