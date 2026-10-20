import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskState } from '@a2a-js/sdk';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store, normalizeResource } from './store.js';
import { A2aService } from './a2a.js';
import { Workspace } from './workspace.js';
import { Completion } from './completion.js';
import { coordinationInstructions, discussionInstructions } from './coordination.js';
import { invariant, type Principal } from './types.js';

const id = z.string().min(1).max(256);
const text = z.string().max(256_000);
const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const dependencies = z
  .object({
    files: z.record(hash).optional(),
    decisions: z.record(z.number().int().positive()).optional(),
  })
  .optional();
const evidence = z.object({
  criterion: z.number().int().min(0),
  description: z.string().min(1),
  files: z.record(hash).optional(),
  operationId: id.optional(),
});

export class MeshTools {
  constructor(
    readonly store: Store,
    readonly a2a: A2aService,
    readonly workspace: Workspace,
    readonly completion: Completion,
    readonly workflow: 'implementation' | 'discussion' = 'implementation',
  ) {}
  private async participation(p: Principal) {
    const mission = await this.store.observe(p.missionId);
    const peers = await this.store.db.query<{ id: string }>(
      `SELECT s.id FROM slots s JOIN runs r ON r.id=s.active_run_id
       JOIN missions m ON m.id=s.mission_id
       WHERE s.mission_id=$1 AND r.generation=s.generation
       AND r.supervisor_epoch=m.supervisor_epoch AND r.state IN ('starting','running')
       AND r.lease_expires>now() ORDER BY s.id`,
      [p.missionId],
    );
    const mayExit = !['active', 'closing'].includes(mission.state);
    return {
      missionState: mission.state,
      workRevision: mission.workRevision,
      mayExit,
      livePeerIds: peers.rows.map((peer) => peer.id),
      nextAction: mayExit
        ? 'The mission is terminal. Record the actual outcome in your final handoff.'
        : 'Remain in this process. Handle reviews and inbox work; otherwise call mesh_wait. Releasing claims is not permission to exit.',
    };
  }
  private async snapshot(
    p: Principal,
    input: {
      query?: string;
      sinceRevision?: string;
      waitMs?: number;
      knowledgeLimit?: number;
      knowledgeCursor?: { updatedAt: string; id: string };
      detail?: 'summary' | 'full';
    } = {},
  ) {
    if (
      input.sinceRevision &&
      !input.query &&
      input.detail !== 'full' &&
      !input.knowledgeCursor &&
      input.knowledgeLimit === undefined
    ) {
      const state = await this.store.waitForRevision(
        p.missionId,
        input.sinceRevision,
        input.waitMs ?? 0,
      );
      if (state.workRevision === input.sinceRevision && state.state === 'active')
        return { unchanged: true, workRevision: state.workRevision };
    }
    // Keep the initial revision so a concurrent change triggers the next refresh.
    const board = (await this.store.board(p, input.query, input)) as Record<string, any>;
    const [inbox, reviews, operations, consultations, participation] = await Promise.all([
      this.a2a.poll(p),
      this.store.db.query(
        'SELECT id,agent_id,kind,target_id,target_revision,manifest_hash,coverage_hash,verdict,reasoning FROM reviews WHERE mission_id=$1 ORDER BY created_at DESC,id LIMIT 100',
        [p.missionId],
      ),
      this.store.db.query(
        `SELECT operation_id,agent_id,kind,state,request->'argv' AS argv,
         result->'exitCode' AS exit_code,result->'sourceAfter' AS source_after,error
         FROM workspace_operations WHERE mission_id=$1 ORDER BY updated_at DESC,operation_id LIMIT 50`,
        [p.missionId],
      ),
      this.store.db.query(
        'SELECT task_id,sender_id,recipient_id,state FROM a2a_tasks WHERE mission_id=$1 AND NOT(state=ANY($2::integer[])) ORDER BY updated_at,task_id LIMIT 100',
        [
          p.missionId,
          [
            TaskState.TASK_STATE_COMPLETED,
            TaskState.TASK_STATE_FAILED,
            TaskState.TASK_STATE_CANCELED,
            TaskState.TASK_STATE_REJECTED,
          ],
        ],
      ),
      this.participation(p),
    ]);
    return {
      ...board,
      detail: input.detail ?? 'summary',
      requirements:
        input.detail === 'full'
          ? board.requirements
          : board.requirements.map(({ evidence, mission_id, updated_at, ...requirement }: any) => ({
              ...requirement,
              evidenceCount: evidence.length,
            })),
      workRevision: board.mission.revision,
      inbox,
      reviews:
        input.detail === 'full'
          ? reviews.rows
          : reviews.rows.map(({ reasoning, ...review }) => ({
              ...review,
              // Objections remain actionable even in a summary.
              ...(review.verdict === 'objection' ? { reasoning } : {}),
            })),
      operations: operations.rows,
      consultations: consultations.rows,
      participation,
      // Discovery lists are bounded; acceptance checks all records.
      limits: { reviews: 100, operations: 50, consultations: 100 },
    };
  }
  server(p: Principal): McpServer {
    const server = new McpServer(
      { name: 'mesh-exec', version: '0.1.0' },
      { capabilities: { logging: {} } },
    );
    const tool = (
      name: string,
      description: string,
      schema: z.ZodRawShape,
      readOnly: boolean,
      body: (a: any) => Promise<unknown>,
    ) => {
      if (
        this.workflow === 'discussion' &&
        ![
          'mesh_join',
          'mesh_ask',
          'mesh_reply',
          'mesh_poll',
          'mesh_ack',
          'mesh_checkpoint',
          'mesh_yield',
        ].includes(name)
      )
        return;
      server.registerTool(
        name,
        {
          description,
          inputSchema: schema,
          annotations: {
            readOnlyHint: readOnly,
            destructiveHint: !readOnly,
            idempotentHint: ['mesh_patch', 'mesh_exec', 'mesh_claim', 'mesh_ack'].includes(name),
            openWorldHint: name === 'mesh_exec',
          },
        },
        async (input) => {
          try {
            const finishing =
              name === 'mesh_wait' ||
              name === 'mesh_board' ||
              name === 'mesh_yield' ||
              name === 'mesh_checkpoint' ||
              (name === 'mesh_operation' && !(input as { cancel?: boolean }).cancel);
            await this.store.assertActive(p, this.store.db, true, finishing);
            const result = await this.store.tracer.span(
              p,
              `tool.${name}`,
              { arguments: input },
              async () => {
                // A peer may finish its normal checkpoint/yield sequence just
                // after acceptance. Report terminal state without mutating it
                // or entering the now-closed workspace/A2A services.
                if (name === 'mesh_board' || name === 'mesh_yield') {
                  const state = await this.store.observe(p.missionId);
                  if (state.state === 'completed') {
                    const participation = await this.participation(p);
                    return name === 'mesh_yield'
                      ? participation
                      : {
                          terminal: true,
                          mission: {
                            id: p.missionId,
                            state: state.state,
                            revision: state.workRevision,
                          },
                          workRevision: state.workRevision,
                          participation,
                        };
                  }
                }
                return body(input);
              },
            );
            return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: error instanceof Error ? error.message : String(error),
                    code: (error as { code?: string }).code,
                    details: (error as { details?: unknown }).details,
                  }),
                },
              ],
            };
          }
        },
      );
    };
    tool(
      'mesh_join',
      'Read your authenticated identity, original roadmap, current board, and predecessor handoff. No roles are assigned.',
      {},
      true,
      async () => {
        const m = await this.store.mission(p.missionId);
        const checkpoints = await this.store.db.query(
          'SELECT id,run_id,body,created_at FROM checkpoints WHERE mission_id=$1 AND agent_id=$2 ORDER BY created_at DESC LIMIT 3',
          [p.missionId, p.agentId],
        );
        if (this.workflow === 'discussion') {
          const peers = (
            await this.store.db.query(
              'SELECT id,state FROM slots WHERE mission_id=$1 ORDER BY id',
              [p.missionId],
            )
          ).rows as { id: string; state: string }[];
          const index = peers.findIndex((peer) => peer.id === p.agentId);
          invariant(
            peers.length >= 2 && index >= 0,
            'DISCUSSION_PEERS_REQUIRED',
            'Discussion requires at least two peers',
          );
          return {
            identity: p,
            roadmap: { path: m.roadmap_path, text: m.roadmap_text, hash: m.roadmap_hash },
            workflow: discussionInstructions,
            profile: this.workflow,
            peers,
            discussionPartner: peers[(index + 1) % peers.length].id,
            inbox: await this.a2a.poll(p),
            checkpoints: checkpoints.rows,
          };
        }
        return {
          identity: p,
          roadmap: { path: m.roadmap_path, text: m.roadmap_text, hash: m.roadmap_hash },
          board: await this.snapshot(p),
          checkpoints: checkpoints.rows,
          protocol: { a2a: '1.0', mcp: 'Streamable HTTP' },
          profile: this.workflow,
          workflow: coordinationInstructions,
        };
      },
    );
    tool(
      'mesh_board',
      'Read shared work, inbox, open consultations, reviews, and reusable operation evidence. Default summary omits requirement evidence and passing review reasoning; use detail=full before reviewing evidence or investigating reviews. Full detail bypasses sinceRevision. knowledgePage includes counts and nextCursor; pass it as knowledgeCursor with the same query to read older knowledge. sinceRevision suppresses unchanged snapshots except explicit knowledge page requests; waitMs waits for change. Search filters knowledge only. Lists are bounded; final acceptance checks all records.',
      {
        detail: z.enum(['summary', 'full']).optional(),
        query: z.string().max(400).optional(),
        sinceRevision: z.string().regex(/^\d+$/).optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
        knowledgeLimit: z.number().int().min(1).max(100).optional(),
        knowledgeCursor: z.object({ updatedAt: z.string().min(1).max(100), id }).optional(),
      },
      true,
      (a) => this.snapshot(p, a),
    );
    tool(
      'mesh_wait',
      'Stay available in this process for reviews and messages. Wait up to 30000 ms (default 20000) without ending your session. Wakes on inbox delivery, shared work change, or mission termination. While mayExit=false, do useful work or wait again; do not send a final handoff.',
      {
        sinceRevision: z
          .string()
          .regex(/^-?\d+$/)
          .optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
      },
      true,
      async (a) => {
        const first = await this.store.observe(p.missionId);
        const revision = a.sinceRevision ?? first.workRevision;
        const deadline = Date.now() + (a.waitMs ?? 20_000);
        for (;;) {
          const state = await this.store.observe(p.missionId);
          if (!['active', 'closing'].includes(state.state)) {
            return { ...(await this.participation(p)), wakeReason: 'mission-terminal' };
          }
          await this.store.assertActive(p, this.store.db, true);
          const pending = await this.store.db.query(
            'SELECT delivery_id FROM mailbox_deliveries WHERE mission_id=$1 AND recipient_id=$2 AND handled_at IS NULL LIMIT 1',
            [p.missionId, p.agentId],
          );
          const wakeReason = pending.rowCount
            ? 'inbox'
            : state.state === 'active' && state.workRevision !== revision
              ? 'shared-work'
              : Date.now() >= deadline
                ? 'timeout'
                : null;
          if (wakeReason) {
            const participation = await this.participation(p);
            return {
              ...participation,
              wakeReason,
              ...(participation.mayExit ? {} : { inbox: await this.a2a.poll(p) }),
            };
          }
          await delay(Math.max(1, Math.min(250, deadline - Date.now())));
        }
      },
    );
    tool(
      'mesh_find_peers',
      'Find stable peer identities and answerability offers, including parked custodians.',
      { query: z.string().max(400).optional() },
      true,
      async (a) => {
        const board = (await this.store.board(p, a.query)) as any;
        return {
          peers: board.peers,
          offers: board.knowledge.filter((k: any) => k.kind === 'offer'),
          workRevision: board.mission.revision,
        };
      },
    );
    tool(
      'mesh_claim',
      'Atomically claim repository-relative paths (src/module.ts), subtrees (src/**), or coordination names (resource:integration). Paths have no file: prefix. Conflicts return owners; choose other useful work.',
      {
        id,
        resources: z.array(z.string()).min(1).max(200),
        intentionId: id.optional(),
        description: z.string().min(1).max(8000),
        requirementIds: z.array(id).optional(),
      },
      false,
      async (a) => {
        for (const resource of a.resources) {
          const normalized = normalizeResource(resource);
          if (!normalized.startsWith('resource:'))
            await this.workspace.canonicalPath(normalized.replace(/\/\*\*$/, ''), {
              allowRoot: true,
            });
        }
        return this.store.claim(p, a);
      },
    );
    tool(
      this.workflow === 'discussion' ? 'mesh_ask' : 'mesh_send',
      this.workflow === 'discussion'
        ? 'Ask your assigned partner one NEW question or proposal. The service chooses the recipient and task IDs. Answer incoming questions with mesh_reply, not this tool.'
        : 'Open a peer consultation. Omit taskId/contextId for a new request; only reuse IDs returned for a task you opened with this recipient. Answer incoming requests with mesh_reply. Reuse messageId only for exact retries.',
      {
        messageId: id,
        text: text.optional(),
        data: z.unknown().optional(),
        ...(this.workflow === 'implementation'
          ? {
              recipientId: id,
              taskId: id.optional(),
              contextId: id.optional(),
              kind: z
                .enum(['question', 'offer', 'proposal', 'challenge', 'correction', 'review'])
                .optional(),
              correlationId: id.optional(),
              causationId: id.optional(),
              references: z.array(z.unknown()).optional(),
            }
          : {}),
      },
      false,
      async (a) => {
        if (this.workflow === 'discussion') {
          const peers = (
            await this.store.db.query<{ id: string }>(
              'SELECT id FROM slots WHERE mission_id=$1 ORDER BY id',
              [p.missionId],
            )
          ).rows;
          const index = peers.findIndex((peer) => peer.id === p.agentId);
          invariant(
            peers.length >= 2 && index >= 0,
            'DISCUSSION_PEERS_REQUIRED',
            'Discussion requires at least two peers',
          );
          a = {
            messageId: a.messageId,
            text: a.text,
            data: a.data,
            recipientId: peers[(index + 1) % peers.length].id,
            kind: 'question',
          };
        }
        const receipt = await this.a2a.send(p, a);
        invariant(
          receipt.state !== 'failed',
          'DELIVERY_FAILED',
          `Peer delivery failed: ${JSON.stringify(receipt.error)}. Outbox: ${receipt.outboxId}`,
        );
        return receipt;
      },
    );
    tool(
      'mesh_reply',
      'Answer a task addressed to your peer. Include the incoming deliveryId to acknowledge that request in the same transaction. Terminal tasks remain terminal; acknowledge terminal answers with mesh_ack.',
      {
        taskId: id,
        messageId: id,
        deliveryId: id.optional(),
        text: text.optional(),
        data: z.unknown().optional(),
        state: z.enum(['completed', 'working', 'input-required', 'rejected', 'failed']).optional(),
      },
      false,
      (a) => this.a2a.reply(p, a),
    );
    tool(
      'mesh_cancel',
      'Cancel an obsolete A2A consultation as a participating peer. The counterpart receives a durable cancellation notice.',
      { recipientId: id, taskId: id },
      false,
      (a) => this.a2a.cancel(p, a),
    );
    tool(
      'mesh_poll',
      'Read pending inbox messages without acknowledging them. waitMs waits for actual pending mail, avoiding empty refreshes. Use mesh_yield for a final handoff revision.',
      {
        limit: z.number().int().min(1).max(128).optional(),
        waitMs: z.number().int().min(0).max(30_000).optional(),
      },
      true,
      async (a) => {
        const result = await this.a2a.poll(p, a);
        await this.store.observed(p, result.workRevision);
        return result;
      },
    );
    tool(
      'mesh_ack',
      'Acknowledge handled inbox deliveries. Supply deliveryId or a batch of deliveryIds with the same disposition. Each acknowledgment is idempotent; a failed batch may have applied earlier entries. This does not close consultation tasks.',
      {
        deliveryId: id.optional(),
        deliveryIds: z.array(id).min(1).max(128).optional(),
        disposition: z.enum(['handled', 'deferred', 'rejected', 'superseded']).optional(),
        reason: text.optional(),
      },
      false,
      async (a) => {
        invariant(
          Boolean(a.deliveryId) !== Boolean(a.deliveryIds),
          'INVALID_ACK',
          'Supply exactly one of deliveryId or deliveryIds',
        );
        if (a.deliveryId) return this.a2a.ack(p, a);
        const acknowledgments = [];
        for (const deliveryId of a.deliveryIds)
          acknowledgments.push(
            await this.a2a.ack(p, {
              deliveryId,
              disposition: a.disposition,
              reason: a.reason,
            }),
          );
        return { acknowledgments };
      },
    );
    tool(
      'mesh_remember',
      'Publish or revise a finding, decision, offer, or blocker with source hashes and typed revision dependencies. Resolve blockers explicitly.',
      {
        id,
        kind: z.enum(['finding', 'decision', 'offer', 'blocker']),
        title: z.string().min(1).max(1000),
        body: text,
        expectedRevision: z.number().int().min(0).optional(),
        evidence: z
          .object({ files: z.record(hash).optional() })
          .passthrough()
          .optional(),
        conditions: z.array(z.unknown()).optional(),
        unknowns: z.array(z.unknown()).optional(),
        readiness: z.enum(['warm', 'parked', 'unavailable']).optional(),
        status: z.enum(['open', 'resolved']).optional(),
        edges: z
          .array(
            z.object({
              toId: id,
              toRevision: z.number().int().positive(),
              kind: z.enum([
                'supports',
                'challenges',
                'depends-on',
                'supersedes',
                'affects',
                'answers',
              ]),
            }),
          )
          .optional(),
      },
      false,
      async (a) => {
        return this.workspace.withBarrier(async () => {
          if (a.evidence?.files) {
            const read = await this.workspace.read(p, Object.keys(a.evidence.files));
            for (const file of read.files)
              invariant(
                file.hash === a.evidence.files[file.path],
                'STALE_EVIDENCE',
                `Evidence for ${file.path} changed`,
              );
          }
          return this.store.remember(p, a);
        });
      },
    );
    tool(
      'mesh_requirement',
      'Create or revise a requirement anchored to literal roadmap text. Criteria are indexed from zero; each needs evidence. An identical update preserves revision and author; real changes invalidate prior reviews.',
      {
        id,
        anchor: z.string().min(1),
        title: z.string().min(1),
        criteria: z.array(z.string().min(1)).min(1),
        expectedRevision: z.number().int().positive().optional(),
        state: z.enum(['open', 'implemented']).optional(),
        evidence: z.array(evidence).optional(),
      },
      false,
      (a) => this.store.requirement(p, a),
    );
    tool(
      'mesh_review',
      'Record an independent requirement or coverage review against the current exact source manifest. Peers must investigate; agreement is not evidence.',
      {
        id,
        kind: z.enum(['requirement', 'coverage']),
        targetId: id.optional(),
        targetRevision: z.number().int().positive().optional(),
        manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
        verdict: z.enum(['pass', 'objection']),
        reasoning: z.string().min(1),
      },
      false,
      async (a) => {
        return this.workspace.withBarrier(async () => {
          const manifest = await this.workspace.manifest();
          invariant(
            a.manifestHash === manifest.hash,
            'STALE_REVIEW',
            'Review source manifest changed',
          );
          await this.store.review(p, a);
          return { id: a.id, manifestHash: manifest.hash };
        });
      },
    );
    tool(
      'mesh_read',
      'Read a coherent file batch with SHA-256 preconditions. Native exploratory reads can observe intermediate multi-file publication.',
      { paths: z.array(z.string()).max(128), manifest: z.boolean().optional() },
      true,
      async (a) =>
        a.manifest
          ? this.workspace.withBarrier(async () => ({
              ...(await this.workspace.read(p, a.paths)),
              manifest: await this.workspace.manifest(),
            }))
          : this.workspace.read(p, a.paths),
    );
    tool(
      'mesh_patch',
      'Publish idempotent guarded complete-file edits or deletions. expectedHash=null requires absence. Claim paths and declare file/decision dependencies.',
      {
        operationId: id,
        claimId: id.optional(),
        changes: z
          .array(
            z.object({
              path: z.string(),
              expectedHash: hash,
              content: z.string().nullable(),
              mode: z.number().int().optional(),
            }),
          )
          .min(1)
          .max(128),
        dependencies,
      },
      false,
      (a) => this.workspace.patch(p, a),
    );
    tool(
      'mesh_exec',
      'Start a bounded command and return an operation handle immediately. cwd is repository-relative: omit it or use "." for the root, never an absolute path. Read commands have confined source access; mutate requires a whole-workspace claim. Use MESH_OUTPUT_DIR for generated output.',
      {
        operationId: id,
        claimId: id.optional(),
        argv: z.array(z.string()).min(1).max(512),
        cwd: z
          .string()
          .describe('Repository-relative working directory; omit or use "." for the root.')
          .optional(),
        mode: z.enum(['read', 'mutate']),
        timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
        network: z.boolean().optional(),
        env: z.record(z.string()).optional(),
        dependencies,
      },
      false,
      (a) => this.workspace.exec(p, a),
    );
    tool(
      'mesh_operation',
      'Inspect a durable command, patch, or completion proposal, with bounded output tails; optionally cancel your active command.',
      { operationId: id, cancel: z.boolean().optional() },
      false,
      async (a) => {
        const proposal = await this.completion.status(p.missionId, a.operationId);
        if (proposal) return proposal;
        return a.cancel
          ? this.workspace.cancel(p, a.operationId)
          : this.workspace.operation(p, a.operationId);
      },
    );
    tool(
      'mesh_checkpoint',
      'Persist a concise handoff with evidence and unresolved work. Omit id for a new record; reusing an id requires exactly the same body.',
      {
        id: id.optional(),
        body: z
          .record(z.unknown())
          .refine((value) => Object.keys(value).length > 0, 'Provide a nonempty checkpoint object'),
      },
      false,
      (a) => this.store.checkpoint(p, a.body, a.id),
    );
    tool(
      'mesh_yield',
      "Cancel and reap this run's outstanding commands and release claims for review. This does not end participation. Implementation peers must remain available with mesh_wait while mayExit=false.",
      { reason: z.string().min(1), waitingOn: z.array(id).optional() },
      false,
      async (a) => {
        const released = await this.workspace.yieldRun(p.runId, () =>
          this.store.yield(p, a.reason, a.waitingOn),
        );
        if (this.workflow === 'discussion') return released;
        return { ...(await this.participation(p)), ...released };
      },
    );
    tool(
      'mesh_propose_completion',
      'Start final acceptance asynchronously. Requires all criteria evidenced, independent reviews, no blockers/claims/open consultations, and successful controlled checks. Inspect with mesh_operation.',
      {
        operationId: id,
        checks: z.array(z.array(z.string()).min(1)).min(1).optional(),
        timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
      },
      false,
      (a) => this.completion.start(p, a),
    );
    return server;
  }
}
