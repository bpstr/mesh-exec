import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../src/daemon.js';
import { TestDatabase } from './helpers.js';
import { exportMission, messages, metrics, status } from '../src/observer.js';
import { readEvents } from '../src/trace.js';
const exec = promisify(execFile);

async function waitForWaitStarted(f: Awaited<ReturnType<typeof fixture>>, count = 1) {
  for (let i = 0; i < 100; i++) {
    const events = await readEvents(f.db, f.daemon.missionId, { kind: 'tool.mesh_wait.started' });
    if (events.length >= count) return;
    await delay(10);
  }
  assert.fail('Peer did not enter its wait');
}

test('usage reports partial receipts, sums turns, and does not count cached input twice', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const initial = (await status(f.db, f.daemon.missionId)).usage as any;
  assert.equal(initial.runsWithoutUsage, 2);
  assert.equal(initial.validReceipts, 0);
  for (const receipt of [
    { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
    { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5 },
    { input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 },
    { input_tokens: '100', cached_input_tokens: 0, output_tokens: 0 },
    null,
  ]) {
    await f.daemon.store.events({
      ...f.a.principal,
      kind: 'codex.turn.completed',
      data: { event: { type: 'turn.completed', usage: receipt } },
    });
  }
  const partial = (await status(f.db, f.daemon.missionId)).usage as any;
  assert.deepEqual(partial.reportedTokens, { input: 150, cachedInput: 80, output: 15, total: 165 });
  assert.equal(partial.runsWithUsage, 1);
  assert.equal(partial.runsWithoutUsage, 1);
  assert.equal(partial.validReceipts, 2);
  assert.equal(partial.invalidReceipts, 3);
  assert.match(partial.note, /unknown/);
  const text = await metrics(f.db, f.daemon.missionId);
  assert.match(text, /mesh_usage_runs\{[^}]+reporting="missing"\} 1/);
  assert.match(text, /mesh_reported_tokens\{[^}]+kind="total"\} 165/);
});

test('participation waits keep sessions live, fence expired runs, and allow terminal exit only', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const joined = await f.call(f.cb, 'mesh_join');
  assert.deepEqual(joined.board.participation.livePeerIds, ['A1', 'A2']);
  assert.equal(joined.board.participation.mayExit, false);
  const released = await f.call(f.cb, 'mesh_yield', { reason: 'Available for later reviews' });
  assert.equal(released.mayExit, false);
  const timeout = await f.call(f.cb, 'mesh_wait', { waitMs: 10 });
  assert.equal(timeout.wakeReason, 'timeout');
  assert.equal(timeout.mayExit, false);
  assert.equal((await f.call(f.cb, 'mesh_join')).identity.runId, f.b.principal.runId);

  // A changed source/requirement must wake an available participant, even without mail.
  const changed = f.call(f.cb, 'mesh_wait', { sinceRevision: timeout.workRevision, waitMs: 2000 });
  await waitForWaitStarted(f, 2);
  await f.call(f.ca, 'mesh_checkpoint', { body: { summary: 'Evidence is ready for inspection' } });
  assert.equal((await changed).wakeReason, 'shared-work');

  const fenced = f.call(f.cb, 'mesh_wait', { waitMs: 2000 });
  const rejected = assert.rejects(fenced, /STALE_RUN/);
  await waitForWaitStarted(f, 3);
  await f.db.query("UPDATE runs SET lease_expires=now()-interval '1 second' WHERE id=$1", [
    f.b.principal.runId,
  ]);
  await rejected;
  const active = await f.call(f.ca, 'mesh_join');
  assert.deepEqual(active.board.participation.livePeerIds, ['A1']);

  // Closing is not permission to leave; a waiting process observes the terminal outcome.
  await f.db.query("UPDATE missions SET state='closing' WHERE id=$1", [f.daemon.missionId]);
  const closing = await f.call(f.ca, 'mesh_wait', { waitMs: 10 });
  assert.equal(closing.mayExit, false);
  assert.equal(closing.missionState, 'closing');
  const terminal = f.call(f.ca, 'mesh_wait', { waitMs: 2000 });
  await waitForWaitStarted(f, 5);
  await f.db.query("UPDATE missions SET state='completed' WHERE id=$1", [f.daemon.missionId]);
  const completed = await terminal;
  assert.equal(completed.mayExit, true);
  assert.equal(completed.wakeReason, 'mission-terminal');
});

test('checkpoint body is required and malformed checkpoints do not reach persistence', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const checkpoint = (await f.ca.listTools()).tools.find(
    (tool) => tool.name === 'mesh_checkpoint',
  )!;
  assert.ok(checkpoint.inputSchema.required?.includes('body'));
  for (const args of [{}, { body: null }, { body: {} }]) {
    assert.equal((await f.ca.callTool({ name: 'mesh_checkpoint', arguments: args })).isError, true);
  }
  assert.equal((await f.db.query('SELECT id FROM checkpoints')).rowCount, 0);
});

test('board knowledge pagination bypasses unchanged snapshots and retains search filters', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  for (const id of ['old', 'new', 'unrelated']) {
    await f.call(f.ca, 'mesh_remember', {
      id,
      kind: 'finding',
      title: id === 'unrelated' ? 'Unrelated' : 'Historical solution',
      body: id,
    });
  }
  const joined = await f.call(f.cb, 'mesh_join');
  assert.equal(joined.board.knowledgePage.summary.total, 3);
  const first = await f.call(f.cb, 'mesh_board', {
    sinceRevision: joined.board.workRevision,
    knowledgeLimit: 1,
    query: 'Historical',
  });
  assert.equal(first.knowledge.length, 1);
  assert.equal(first.knowledgePage.summary.total, 2);
  const second = await f.call(f.cb, 'mesh_board', {
    sinceRevision: first.workRevision,
    knowledgeCursor: first.knowledgePage.nextCursor,
    query: 'Historical',
  });
  assert.equal(second.knowledge.length, 1);
  assert.notEqual(first.knowledge[0].id, second.knowledge[0].id);
  assert.equal(second.knowledgePage.hasMore, false);
  // A cursor-only request must also bypass sinceRevision without a search query.
  const all = await f.call(f.cb, 'mesh_board', { knowledgeLimit: 1 });
  const remaining = await f.call(f.cb, 'mesh_board', {
    sinceRevision: all.workRevision,
    knowledgeCursor: all.knowledgePage.nextCursor,
  });
  assert.equal(remaining.knowledge.length, 2);
});

async function fixture(
  workflow: 'implementation' | 'discussion' = 'implementation',
  limits: { maxCommands?: number; maxQueuedCommands?: number } = {},
) {
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
    agents: workflow === 'discussion' ? 3 : 2,
    config: { workflow },
    port: 0,
    ...limits,
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

test(
  'command overload is explicit over MCP and effective limits remain in the trace',
  { timeout: 16_384 },
  async (t) => {
    const f = await fixture('implementation', { maxCommands: 1, maxQueuedCommands: 0 });
    t.after(f.close);
    const ready = await readEvents(f.db, f.daemon.missionId, { kind: 'daemon.ready' });
    assert.deepEqual((ready[0].data as any).commandCapacity, {
      maxCommands: 1,
      maxQueuedCommands: 0,
    });
    const active = {
      operationId: 'mcp-active',
      mode: 'read',
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1024)'],
    };
    await f.call(f.ca, 'mesh_exec', active);
    const rejected = await f.cb.callTool({
      name: 'mesh_exec',
      arguments: {
        operationId: 'mcp-overload',
        mode: 'read',
        argv: [process.execPath, '-e', 'process.exit(0)'],
      },
    });
    assert.equal(rejected.isError, true);
    const payload = JSON.parse((rejected.content as { text: string }[])[0].text);
    assert.equal(payload.code, 'command_queue_full');
    assert.equal(payload.details.retryable, true);
    assert.equal(payload.details.admissionLimit, 1);
    assert.equal(payload.details.acceptedCommands, 1);
    const replay = await f.call(f.ca, 'mesh_exec', active);
    assert.equal(replay.operation_id, active.operationId);
    const failures = await readEvents(f.db, f.daemon.missionId, { kind: 'tool.mesh_exec.failed' });
    assert.equal(failures.length, 1);
    const pressure = await readEvents(f.db, f.daemon.missionId, {
      kind: 'workspace.command.rejected',
    });
    assert.equal(pressure.length, 1);
    assert.equal(pressure[0].operationId, 'mcp-overload');
    assert.equal(
      (
        await f.db.query('SELECT operation_id FROM workspace_operations WHERE operation_id=$1', [
          'mcp-overload',
        ])
      ).rows.length,
      0,
    );
    const cancelled = await f.call(f.ca, 'mesh_operation', {
      operationId: active.operationId,
      cancel: true,
    });
    assert.equal(cancelled.state, 'cancelled');
  },
);

test('discussion profile exposes only communication tools and gives each peer one partner', async (t) => {
  const f = await fixture('discussion');
  t.after(f.close);
  assert.deepEqual((await f.ca.listTools()).tools.map((tool) => tool.name).sort(), [
    'mesh_ack',
    'mesh_ask',
    'mesh_checkpoint',
    'mesh_join',
    'mesh_poll',
    'mesh_reply',
    'mesh_yield',
  ]);
  const ask = (await f.ca.listTools()).tools.find((tool) => tool.name === 'mesh_ask')!;
  assert.equal(ask.inputSchema.properties?.recipientId, undefined);
  assert.equal(ask.inputSchema.properties?.taskId, undefined);
  assert.equal(ask.inputSchema.properties?.contextId, undefined);
  const question = await f.call(f.ca, 'mesh_ask', {
    messageId: 'round-question',
    text: 'Which option is clearer?',
  });
  assert.equal(question.recipientId, 'A2');
  const incoming = await f.call(f.cb, 'mesh_poll');
  await f.call(f.cb, 'mesh_reply', {
    taskId: question.taskId,
    messageId: 'round-answer',
    deliveryId: incoming.messages[0].deliveryId,
    text: 'The first is clearer because it is shorter.',
    state: 'completed',
  });
  assert.equal((await f.call(f.cb, 'mesh_poll')).messages.length, 0);
  const answer = await f.call(f.ca, 'mesh_poll');
  await f.call(f.ca, 'mesh_ack', { deliveryId: answer.messages[0].deliveryId });
  const joined = await f.call(f.ca, 'mesh_join');
  assert.equal(joined.profile, 'discussion');
  assert.equal(joined.discussionPartner, 'A2');
  assert.equal((await f.call(f.cb, 'mesh_join')).discussionPartner, 'A3');
  assert.equal(joined.inbox.messages.length, 0);
  assert.equal(joined.board, undefined);
  assert.deepEqual(joined.checkpoints, []);
  await assert.rejects(f.call(f.ca, 'mesh_propose_completion', { operationId: 'not-available' }));
});

test('permanent delivery failure is a tool error and a failed span, not a successful receipt', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    f.call(f.ca, 'mesh_send', {
      recipientId: 'A2',
      messageId: 'invalid-task',
      taskId: 'invented-task',
      text: 'A new request must not invent task IDs.',
    }),
    /DELIVERY_FAILED/,
  );
  const events = await readEvents(f.db, f.daemon.missionId, { limit: 2000 });
  assert.equal(events.filter((event) => event.kind === 'tool.mesh_send.failed').length, 1);
  assert.equal(events.filter((event) => event.kind === 'tool.mesh_send.completed').length, 0);
  assert.equal(
    (await f.db.query('SELECT state FROM a2a_outbox WHERE mission_id=$1', [f.daemon.missionId]))
      .rows[0].state,
    'failed',
  );
});

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
  assert.equal(joined.board.inbox.messages.length, 0);
  const unchanged = await f.call(f.ca, 'mesh_board', {
    sinceRevision: joined.board.workRevision,
    waitMs: 5,
  });
  assert.deepEqual(unchanged, { unchanged: true, workRevision: joined.board.workRevision });
  const waiting = f.call(f.ca, 'mesh_board', {
    sinceRevision: unchanged.workRevision,
    waitMs: 2000,
  });
  await f.call(f.cb, 'mesh_checkpoint', { body: { summary: 'Available for independent review' } });
  const refreshed = await waiting;
  assert.notEqual(refreshed.workRevision, unchanged.workRevision);
  assert.equal(
    refreshed.peers.find((p: any) => p.id === 'A2').handoff.summary,
    'Available for independent review',
  );
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
  // The reviewer stays in its original authenticated process after releasing work.
  const releasedReviewer = await f.call(f.cb, 'mesh_yield', { reason: 'Available for review' });
  assert.equal(releasedReviewer.mayExit, false);
  const reviewWait = f.call(f.cb, 'mesh_wait', { waitMs: 2000 });
  await waitForWaitStarted(f);
  const request = await f.call(f.ca, 'mesh_send', {
    recipientId: 'A2',
    messageId: 'question-1',
    text: 'Should zero be represented as "0"?\nPlease inspect the roadmap.',
    kind: 'question',
  });
  const consultationBoard = await f.call(f.cb, 'mesh_board');
  assert.equal(consultationBoard.consultations[0].task_id, request.taskId);
  const awakenedReviewer = await reviewWait;
  assert.equal(awakenedReviewer.wakeReason, 'inbox');
  assert.equal(awakenedReviewer.mayExit, false);
  assert.equal((await f.call(f.cb, 'mesh_join')).identity.runId, f.b.principal.runId);
  const incoming = awakenedReviewer.inbox;
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
  const reviewed = await f.call(f.ca, 'mesh_board');
  assert.equal(reviewed.reviews.length, 2);
  assert.equal(reviewed.detail, 'summary');
  assert.equal(reviewed.requirements[0].evidenceCount, 1);
  assert.equal(reviewed.requirements[0].evidence, undefined);
  assert.equal(reviewed.reviews[0].reasoning, undefined);
  const detailed = await f.call(f.ca, 'mesh_board', {
    detail: 'full',
    sinceRevision: reviewed.workRevision,
  });
  assert.equal(detailed.detail, 'full');
  assert.equal(detailed.requirements[0].evidence.length, 1);
  assert.ok(detailed.reviews.every((review: any) => review.reasoning.length > 0));
  assert.equal(
    reviewed.operations.find((op: any) => op.operation_id === 'write-counter').state,
    'applied',
  );
  assert.equal(reviewed.consultations.length, 0);
  assert.equal(reviewed.inbox.messages.length, 0);
  const released = await f.call(f.ca, 'mesh_yield', {
    reason: 'Implementation ready for final verification',
  });
  assert.equal(released.mayExit, false);
  // Final verification spawns a sandboxed process; allow for host startup load.
  const acceptanceWait = f.call(f.cb, 'mesh_wait', { waitMs: 10_000 });
  await waitForWaitStarted(f, 2);
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
  const acceptedParticipation = await acceptanceWait;
  assert.equal(acceptedParticipation.mayExit, true, JSON.stringify(acceptedParticipation));
  // Accepted missions retain only terminal status/checkpoint access for a live,
  // leased generation; normal work and A2A authentication stay closed.
  assert.equal((await f.call(f.cb, 'mesh_wait')).mayExit, true);
  const finalBoard = await f.call(f.cb, 'mesh_board');
  assert.equal(finalBoard.terminal, true);
  assert.equal(finalBoard.participation.mayExit, true);
  const finalYield = await f.call(f.cb, 'mesh_yield', { reason: 'Final checkpoint complete' });
  assert.equal(finalYield.mayExit, true);
  assert.equal(finalYield.workRevision, finalBoard.workRevision);
  assert.equal((await f.daemon.store.mission(mission.id)).revision, mission.revision);
  assert.equal(
    (await f.call(f.ca, 'mesh_operation', { operationId: 'finish-1' })).state,
    'completed',
  );
  await f.call(f.ca, 'mesh_checkpoint', { body: { summary: 'Acceptance complete' } });
  assert.deepEqual((await f.daemon.store.mission(mission.id)).acceptance, mission.acceptance);
  await assert.rejects(
    f.call(f.ca, 'mesh_claim', {
      id: 'after-acceptance',
      resources: ['counter.txt'],
      description: 'Forbidden new work',
    }),
    /STALE_RUN/,
  );
  await assert.rejects(
    f.call(f.ca, 'mesh_operation', { operationId: 'finish-1', cancel: true }),
    /STALE_RUN/,
  );
  await assert.rejects(f.daemon.store.authenticate(f.a.token), /Run is finished/);
  await f.db.query("UPDATE runs SET lease_expires=now()-interval '1 second' WHERE id=$1", [
    f.b.principal.runId,
  ]);
  await assert.rejects(f.call(f.cb, 'mesh_wait'));
  await assert.rejects(f.call(f.cb, 'mesh_board'));
  await assert.rejects(f.call(f.cb, 'mesh_yield', { reason: 'Expired run' }));
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
  const operatorHeaders = { Authorization: `Bearer ${f.daemon.operatorToken}` };
  const forbidden = await fetch(f.daemon.url + '/observer/runs', {
    headers: { Authorization: `Bearer ${f.a.token}` },
  });
  assert.equal(forbidden.status, 401);
  const inspected = await fetch(f.daemon.url + '/observer/runs', { headers: operatorHeaders });
  assert.equal(inspected.status, 200);
  assert.equal(((await inspected.json()) as any).runs.length, 2);
  const invalidCursor = await fetch(f.daemon.url + '/observer/events/stream?after=invalid', {
    headers: operatorHeaders,
  });
  assert.equal(invalidCursor.status, 400);
  const cutoff = events.at(-1)!.seq;
  const initialEvents = events.filter((e) => e.kind.startsWith('message.'));
  const streamUrl = `${f.daemon.url}/observer/events/stream?kindPrefix=message.&until=${cutoff}&limit=2`;
  const streamed = await fetch(streamUrl, { headers: operatorHeaders });
  assert.match(streamed.headers.get('content-type')!, /text\/event-stream/);
  const body = await streamed.text();
  assert.ok(body.includes('Should zero be represented'));
  const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(
    ids,
    initialEvents.map((e) => e.seq),
  );
  const replay = await fetch(streamUrl, {
    headers: { ...operatorHeaders, 'Last-Event-ID': initialEvents[0].seq },
  });
  const replayIds = [...(await replay.text()).matchAll(/^id: (\d+)$/gm)].map((m) => m[1]);
  assert.deepEqual(
    replayIds,
    initialEvents.slice(1).map((e) => e.seq),
  );
});

test('yield releases claims without ending a live peer; corrected path claims can publish', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await assert.rejects(
    f.call(f.ca, 'mesh_claim', {
      id: 'bad-path',
      resources: ['file:counter.txt'],
      description: 'Write counter',
    }),
    /INVALID_RESOURCE.*without a file: prefix/,
  );
  await f.call(f.ca, 'mesh_claim', {
    id: 'first',
    resources: ['counter.txt'],
    description: 'Write counter',
  });
  await f.call(f.ca, 'mesh_yield', { reason: 'Release initial contribution' });
  await assert.rejects(
    f.call(f.ca, 'mesh_patch', {
      operationId: 'without-reclaim',
      changes: [{ path: 'counter.txt', expectedHash: null, content: '0\n' }],
    }),
    /CLAIM_REQUIRED/,
  );
  await f.call(f.ca, 'mesh_claim', {
    id: 'correction',
    resources: ['counter.txt'],
    description: 'Correct source before final review',
  });
  const result = await f.call(f.ca, 'mesh_patch', {
    operationId: 'after-reclaim',
    claimId: 'correction',
    changes: [{ path: 'counter.txt', expectedHash: null, content: '0\n' }],
  });
  assert.equal(result.state, 'applied');
  await f.daemon.workspace.cancelRun(f.a.principal.runId);
  await assert.rejects(
    f.call(f.ca, 'mesh_patch', {
      operationId: 'after-revocation',
      claimId: 'correction',
      changes: [{ path: 'counter.txt', expectedHash: result.result.files[0].hash, content: '1\n' }],
    }),
    /run_revoked/,
  );
});

test('batched acknowledgments preserve task state and safely replay after a partial failure', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.call(f.ca, 'mesh_send', {
    recipientId: 'A2',
    messageId: 'first',
    text: 'Inspect source',
  });
  await f.call(f.ca, 'mesh_send', {
    recipientId: 'A2',
    messageId: 'second',
    text: 'Inspect coverage',
  });
  const board = await f.call(f.cb, 'mesh_board');
  const deliveryIds = board.inbox.messages.map((m: any) => m.deliveryId);
  assert.equal(deliveryIds.length, 2);
  await assert.rejects(
    f.call(f.cb, 'mesh_ack', { deliveryId: deliveryIds[0], deliveryIds }),
    /INVALID_ACK/,
  );
  await assert.rejects(
    f.call(f.cb, 'mesh_ack', { deliveryIds: [deliveryIds[0], 'missing'] }),
    /NOT_FOUND/,
  );
  const acknowledged = await f.call(f.cb, 'mesh_ack', { deliveryIds });
  assert.equal(acknowledged.acknowledgments[0].replayed, true);
  assert.equal(acknowledged.acknowledgments[1].replayed, false);
  const after = await f.call(f.cb, 'mesh_board');
  assert.equal(after.inbox.messages.length, 0);
  assert.equal(after.consultations.length, 2);
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
