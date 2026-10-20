import { randomUUID } from 'node:crypto';
import { TaskState } from '@a2a-js/sdk';
import { Store, canonicalJson, manifestHash } from './store.js';
import { Workspace, type SourceManifest, type CommandResult } from './workspace.js';
import { invariant, type Principal, type Sql } from './types.js';

interface Requirement {
  id: string;
  revision: number;
  state: string;
  criteria: string[];
  evidence: {
    criterion: number;
    description: string;
    files?: Record<string, string | null>;
    operationId?: string;
  }[];
  author_agent: string;
}
interface Review {
  id: string;
  agent_id: string;
  kind: string;
  target_id: string;
  target_revision: number;
  verdict: string;
  manifest_hash: string;
  roadmap_hash: string;
  coverage_hash: string | null;
}

export class Completion {
  private pending = new Set<Promise<void>>();
  constructor(
    private store: Store,
    private workspace: Workspace,
  ) {}
  async start(
    p: Principal,
    input: { operationId: string; checks?: string[][]; timeoutMs?: number },
  ): Promise<unknown> {
    const created = await this.store.db.transaction(async (tx) => {
      await this.store.lock(tx, p.missionId);
      await this.store.assertActive(p, tx);
      const prior = await tx.query<{ run_id: string; request: unknown }>(
        'SELECT * FROM completion_proposals WHERE mission_id=$1 AND operation_id=$2',
        [p.missionId, input.operationId],
      );
      if (prior.rows[0]) {
        invariant(
          prior.rows[0].run_id === p.runId &&
            canonicalJson(prior.rows[0].request) === canonicalJson(input),
          'IDEMPOTENCY_CONFLICT',
          'Completion ID was used for a different proposal',
        );
        return false;
      }
      await tx.query(
        'INSERT INTO completion_proposals(mission_id,operation_id,run_id,request) VALUES($1,$2,$3,$4::jsonb)',
        [p.missionId, input.operationId, p.runId, JSON.stringify(input)],
      );
      await this.store.events(
        { ...p, kind: 'completion.proposed', operationId: input.operationId, data: input },
        tx,
      );
      return true;
    });
    if (created) {
      const work = (async () => {
        try {
          await this.transition(p, input.operationId, 'running');
          const result = await this.propose(p, input);
          await this.transition(p, input.operationId, 'completed', result);
        } catch (error) {
          await this.transition(p, input.operationId, 'failed', undefined, {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work)).catch(() => {});
    }
    return {
      operationId: input.operationId,
      kind: 'completion',
      state: 'accepted',
      inspectWith: 'mesh_operation',
    };
  }
  async status(missionId: string, operationId: string): Promise<unknown | undefined> {
    return (
      await this.store.db.query(
        'SELECT operation_id,state,result,error FROM completion_proposals WHERE mission_id=$1 AND operation_id=$2',
        [missionId, operationId],
      )
    ).rows[0];
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.pending);
  }
  private async transition(
    p: Principal,
    operationId: string,
    state: string,
    result?: unknown,
    error?: unknown,
  ): Promise<void> {
    await this.store.db.transaction(async (tx) => {
      await this.store.lock(tx, p.missionId);
      await tx.query(
        'UPDATE completion_proposals SET state=$3,result=$4::jsonb,error=$5::jsonb,updated_at=now() WHERE mission_id=$1 AND operation_id=$2',
        [
          p.missionId,
          operationId,
          state,
          JSON.stringify(result ?? null),
          JSON.stringify(error ?? null),
        ],
      );
      await this.store.events(
        { ...p, kind: `completion.proposal.${state}`, operationId, data: { result, error } },
        tx,
      );
    });
  }
  private async conditions(tx: Sql, p: Principal, manifest: SourceManifest): Promise<unknown> {
    const mission = await this.store.mission(p.missionId, tx);
    const requirements = (
      await tx.query<Requirement>('SELECT * FROM requirements WHERE mission_id=$1 ORDER BY id', [
        p.missionId,
      ])
    ).rows;
    invariant(
      requirements.length > 0,
      'NO_COVERAGE',
      'Agents must record roadmap requirements before proposing completion',
    );
    const coverageHash = manifestHash(
      requirements.map((r) => ({ id: r.id, revision: r.revision })),
    );
    const reviews = (
      await tx.query<Review>(
        `SELECT DISTINCT ON (agent_id,kind,COALESCE(target_id,'')) * FROM reviews WHERE mission_id=$1 AND manifest_hash=$2 AND roadmap_hash=$3 ORDER BY agent_id,kind,COALESCE(target_id,''),created_at DESC,id DESC`,
        [p.missionId, manifest.hash, mission.roadmap_hash],
      )
    ).rows.filter((r) =>
      r.kind === 'coverage'
        ? r.coverage_hash === coverageHash
        : requirements.some((q) => q.id === r.target_id && q.revision === r.target_revision),
    );
    invariant(
      reviews.some(
        (r) => r.kind === 'coverage' && r.verdict === 'pass' && r.agent_id !== p.agentId,
      ),
      'COVERAGE_REVIEW_REQUIRED',
      'A different peer must review coverage against the original roadmap and this source manifest',
    );
    invariant(
      !reviews.some((r) => r.verdict === 'objection'),
      'OPEN_OBJECTION',
      'A current review contains an unresolved objection',
    );
    const files = new Map(manifest.files.map((f) => [f.path, f.hash]));
    for (const requirement of requirements) {
      invariant(
        requirement.state === 'implemented',
        'UNMET_REQUIREMENT',
        `Requirement ${requirement.id} is not implemented`,
      );
      for (let i = 0; i < requirement.criteria.length; i++) {
        const evidence = requirement.evidence.filter(
          (e) =>
            e &&
            e.criterion === i &&
            typeof e.description === 'string' &&
            e.description.trim().length > 0,
        );
        invariant(
          evidence.length > 0,
          'MISSING_EVIDENCE',
          `${requirement.id} criterion ${i} has no acceptance evidence`,
        );
        for (const e of evidence) {
          for (const [path, expected] of Object.entries(e.files ?? {}))
            invariant(
              (files.get(path) ?? null) === expected,
              'STALE_EVIDENCE',
              `Acceptance evidence for ${path} is stale`,
            );
          if (e.operationId) {
            const op = await tx.query<{ state: string; result: any }>(
              'SELECT state,result FROM workspace_operations WHERE mission_id=$1 AND operation_id=$2',
              [p.missionId, e.operationId],
            );
            invariant(
              op.rows[0]?.state === 'succeeded' &&
                op.rows[0]?.result?.sourceAfter === manifest.hash,
              'STALE_TEST_EVIDENCE',
              `Operation ${e.operationId} is not a passing check on this manifest`,
            );
          }
        }
      }
      invariant(
        reviews.some(
          (r) =>
            r.kind === 'requirement' &&
            r.target_id === requirement.id &&
            r.target_revision === requirement.revision &&
            r.verdict === 'pass' &&
            r.agent_id !== requirement.author_agent,
        ),
        'REVIEW_REQUIRED',
        `Requirement ${requirement.id} needs a current independent review`,
      );
    }
    const blockers = await tx.query(
      "SELECT id FROM knowledge WHERE mission_id=$1 AND ((kind='blocker' AND status='open') OR (kind='decision' AND freshness='stale'))",
      [p.missionId],
    );
    invariant(
      !blockers.rowCount,
      'BLOCKED',
      'Resolve blockers and stale decisions before completion',
    );
    const held = await tx.query(
      "SELECT id FROM claims WHERE mission_id=$1 AND state IN ('held','quarantined')",
      [p.missionId],
    );
    invariant(
      !held.rowCount,
      'CLAIMS_ACTIVE',
      'Peers must release their write claims before final validation',
    );
    const tasks = await tx.query(
      'SELECT task_id FROM a2a_tasks WHERE mission_id=$1 AND NOT(state=ANY($2::integer[]))',
      [
        p.missionId,
        [
          TaskState.TASK_STATE_COMPLETED,
          TaskState.TASK_STATE_FAILED,
          TaskState.TASK_STATE_CANCELED,
          TaskState.TASK_STATE_REJECTED,
        ],
      ],
    );
    invariant(
      !tasks.rowCount,
      'CONSULTATIONS_ACTIVE',
      'Resolve or explicitly cancel outstanding peer consultations',
    );
    const outbox = await tx.query(
      "SELECT outbox_id FROM a2a_outbox WHERE mission_id=$1 AND state IN ('pending','sending')",
      [p.missionId],
    );
    invariant(
      !outbox.rowCount,
      'OUTBOX_PENDING',
      'Wait for accepted outgoing messages to reach their recipients',
    );
    const inbox = await tx.query(
      'SELECT delivery_id FROM mailbox_deliveries WHERE mission_id=$1 AND handled_at IS NULL',
      [p.missionId],
    );
    invariant(
      !inbox.rowCount,
      'MAIL_UNHANDLED',
      'Peers must handle pending replies and corrections before acceptance',
    );
    return {
      requirements: requirements.map((r) => ({ id: r.id, revision: r.revision })),
      reviews: reviews.map((r) => r.id).sort(),
      roadmapHash: mission.roadmap_hash,
      revision: String(mission.revision),
    };
  }
  async propose(
    p: Principal,
    input: { operationId: string; checks?: string[][]; timeoutMs?: number },
  ): Promise<unknown> {
    await this.store.assertActive(p);
    const mission = await this.store.mission(p.missionId);
    const configured = mission.config.verification as string[][] | undefined;
    const checks = configured?.length ? configured : input.checks;
    invariant(
      checks?.length &&
        checks.every((c) => Array.isArray(c) && c.length && c.every((a) => typeof a === 'string')),
      'CHECKS_REQUIRED',
      'Provide final verification argument arrays, or configure them when starting the mission',
    );
    let closing = false;
    try {
      return await this.workspace.withBarrier(async (barrier) => {
        const before = await barrier.manifest();
        const frozen = await this.store.db.transaction(async (tx) => {
          await this.store.lock(tx, p.missionId);
          await this.store.assertActive(p, tx);
          await tx.query("UPDATE missions SET state='closing' WHERE id=$1", [p.missionId]);
          const snapshot = await this.conditions(tx, p, before);
          await this.store.events(
            {
              ...p,
              kind: 'completion.barrier.closed',
              operationId: input.operationId,
              data: { manifest: before, snapshot, checks },
            },
            tx,
          );
          return snapshot;
        });
        closing = true;
        const results: CommandResult[] = [];
        for (let i = 0; i < checks.length; i++) {
          const result = await barrier.verify(checks[i], {
            principal: { ...p, runId: `verification:${input.operationId}` },
            operationId: `${input.operationId}:check:${i}`,
            timeoutMs: input.timeoutMs ?? 600_000,
          });
          results.push(result);
          invariant(result.exitCode === 0, 'VERIFICATION_FAILED', `Final check ${i + 1} failed`);
        }
        const after = await barrier.manifest();
        invariant(
          before.hash === after.hash,
          'SOURCE_CHANGED',
          'Source changed during final validation',
        );
        const acceptance = await this.store.db.transaction(async (tx) => {
          await this.store.lock(tx, p.missionId);
          const m = await this.store.mission(p.missionId, tx);
          invariant(m.state === 'closing', 'BARRIER_LOST', 'Completion barrier was interrupted');
          const current = await this.conditions(tx, p, after);
          invariant(
            canonicalJson(current) === canonicalJson(frozen),
            'STATE_CHANGED',
            'Coordination state changed during validation; review the new state',
          );
          const id = randomUUID();
          await tx.query(
            'INSERT INTO verifications(id,mission_id,manifest_hash,results,passed) VALUES($1,$2,$3,$4::jsonb,true)',
            [id, p.missionId, after.hash, JSON.stringify(results)],
          );
          const record = {
            id,
            manifest: after,
            checks,
            results,
            coverage: current,
            proposedBy: p,
            operationId: input.operationId,
            completedAt: new Date().toISOString(),
          };
          await tx.query(
            "UPDATE missions SET state='completed',acceptance=$2::jsonb,revision=revision+1,updated_at=now() WHERE id=$1",
            [p.missionId, JSON.stringify(record)],
          );
          await this.store.events(
            { ...p, kind: 'mission.completed', operationId: input.operationId, data: record },
            tx,
          );
          return record;
        });
        return { completed: true, acceptance };
      });
    } catch (error) {
      if (closing)
        await this.store.db.transaction(async (tx) => {
          await this.store.lock(tx, p.missionId);
          await tx.query(
            "UPDATE missions SET state='active',revision=revision+1 WHERE id=$1 AND state='closing'",
            [p.missionId],
          );
          await this.store.events(
            {
              ...p,
              kind: 'completion.reopened',
              operationId: input.operationId,
              data: { error: error instanceof Error ? error.message : String(error) },
            },
            tx,
          );
        });
      throw error;
    }
  }
}
