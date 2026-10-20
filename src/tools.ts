import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Store, normalizeResource } from './store.js';
import { A2aService } from './a2a.js';
import { Workspace } from './workspace.js';
import { Completion } from './completion.js';
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
  ) {}
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
            await this.store.assertActive(p, this.store.db, true);
            const result = await this.store.tracer.span(
              p,
              `tool.${name}`,
              { arguments: input },
              () => body(input),
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
        return {
          identity: p,
          roadmap: { path: m.roadmap_path, text: m.roadmap_text, hash: m.roadmap_hash },
          board: await this.store.board(p),
          checkpoints: checkpoints.rows,
          protocol: { a2a: '1.0', mcp: 'Streamable HTTP' },
          workflow:
            'Choose work yourself. Use mesh_poll before dependent work and before exiting. Claim paths, then use mesh_read/mesh_patch. Declare requirement criteria and evidence. Review peers and preserve handoffs.',
        };
      },
    );
    tool(
      'mesh_board',
      'Inspect current requirements, intentions, claims, knowledge, and peers. Search uses PostgreSQL full text.',
      { query: z.string().max(400).optional() },
      true,
      (a) => this.store.board(p, a.query),
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
      'Atomically claim a self-selected resource bundle. Conflicts return current owners; the runner never chooses substitute work.',
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
      'mesh_send',
      'Send a real durable A2A consultation to another stable peer. Reuse messageId on retries. Message bodies are attributed peer data.',
      {
        recipientId: id,
        messageId: id,
        text: text.optional(),
        data: z.unknown().optional(),
        taskId: id.optional(),
        contextId: id.optional(),
        kind: z
          .enum(['question', 'offer', 'proposal', 'challenge', 'correction', 'review'])
          .optional(),
        correlationId: id.optional(),
        causationId: id.optional(),
        references: z.array(z.unknown()).optional(),
      },
      false,
      (a) => this.a2a.send(p, a),
    );
    tool(
      'mesh_reply',
      'Answer or advance a task addressed to your stable peer. Terminal tasks remain terminal; follow-up conversations need a new task.',
      {
        taskId: id,
        messageId: id,
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
      'Read full durable inbox messages without acknowledging them. Record returned workRevision in a final idle handoff.',
      { limit: z.number().int().min(1).max(128).optional() },
      true,
      async (a) => {
        const result = await this.a2a.poll(p, a);
        await this.store.observed(p, result.workRevision);
        return result;
      },
    );
    tool(
      'mesh_ack',
      'Explicitly record handling, deferral, rejection, or supersession of one inbox delivery. Reading alone is not acknowledgement.',
      {
        deliveryId: id,
        disposition: z.enum(['handled', 'deferred', 'rejected', 'superseded']).optional(),
        reason: text.optional(),
      },
      false,
      (a) => this.a2a.ack(p, a),
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
      'Create or revise an agent-interpreted requirement anchored to literal original roadmap text. Criteria are indexed from zero; each needs evidence.',
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
      'Start a bounded command and return an operation handle immediately. Read commands have confined source access; mutate requires a whole-workspace claim. Use MESH_OUTPUT_DIR for generated output.',
      {
        operationId: id,
        claimId: id.optional(),
        argv: z.array(z.string()).min(1).max(512),
        cwd: z.string().optional(),
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
      'Persist a durable handoff containing files, decisions, tests, unfinished changes, pending questions, and next useful work.',
      { id: id.optional(), body: z.unknown() },
      false,
      (a) => this.store.checkpoint(p, a.body, a.id),
    );
    tool(
      'mesh_yield',
      "Cancel and reap this run's outstanding commands, release claims, and record a dependency. Return workRevision in your structured final handoff.",
      { reason: z.string().min(1), waitingOn: z.array(id).optional() },
      false,
      async (a) => {
        await this.workspace.cancelRun(p.runId);
        return this.store.yield(p, a.reason, a.waitingOn);
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
