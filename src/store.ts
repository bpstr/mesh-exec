import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { CORE_SCHEMA } from './schema.js';
import { Tracer, registerSecret } from './trace.js';
import {
  MeshError,
  invariant,
  type Database,
  type Principal,
  type Sql,
  type MissionState,
} from './types.js';

export const hash = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}
export const manifestHash = (manifest: unknown): string => hash(canonicalJson(manifest));

export interface Mission {
  id: string;
  repo: string;
  roadmap_path: string;
  roadmap_text: string;
  roadmap_hash: string;
  baseline: Record<string, unknown>;
  config: Record<string, unknown>;
  state: MissionState;
  revision: string;
  supervisor_epoch: number;
  acceptance: unknown;
}
export interface Dependencies {
  files?: Record<string, string | null>;
  decisions?: Record<string, number>;
}
export interface ClaimInput {
  id: string;
  resources: string[];
  intentionId?: string;
  description: string;
  requirementIds?: string[];
}

/** Resources use file paths, subtree suffix '/**', or explicit named resources. */
export function normalizeResource(input: string): string {
  invariant(
    input.length > 0 && input.length < 4096 && !input.includes('\0') && !input.includes('\\'),
    'INVALID_RESOURCE',
    'Invalid resource',
  );
  if (input.startsWith('resource:')) {
    invariant(
      /^resource:[a-zA-Z0-9_.:/-]+$/.test(input),
      'INVALID_RESOURCE',
      'Invalid named resource',
    );
    return input;
  }
  invariant(
    !input.startsWith('file:'),
    'INVALID_RESOURCE',
    'File claims use repository-relative paths without a file: prefix; use resource:name only for coordination.',
  );
  if (input === '.' || input === './**') return '.';
  invariant(
    !input.startsWith('/') && !input.split('/').some((p) => p === '..'),
    'INVALID_RESOURCE',
    'Resource must be relative and cannot contain ..',
  );
  const result = input
    .split('/')
    .filter((p) => p !== '.' && p !== '')
    .join('/');
  invariant(
    result !== '.git' && !result.startsWith('.git/'),
    'PROTECTED_RESOURCE',
    'Git metadata is owned by the operator',
  );
  invariant(
    result.length > 0 &&
      (!result.includes('*') || (result.endsWith('/**') && !result.slice(0, -3).includes('*'))),
    'INVALID_RESOURCE',
    'Use an exact path or subtree/**',
  );
  return result;
}
export function overlaps(a: string, b: string): boolean {
  if (a.startsWith('resource:') || b.startsWith('resource:')) return a === b;
  if (a === '.' || b === '.') return true;
  const aa = a.replace(/\/\*\*$/, '');
  const bb = b.replace(/\/\*\*$/, '');
  return aa === bb || aa.startsWith(bb + '/') || bb.startsWith(aa + '/');
}
export function covers(resource: string, path: string): boolean {
  if (resource === '.') return !path.startsWith('resource:');
  if (resource.startsWith('resource:')) return resource === path;
  return resource.endsWith('/**')
    ? path === resource.slice(0, -3) || path.startsWith(resource.slice(0, -2))
    : path === resource;
}
async function processStart(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}
async function processBoot(): Promise<string | null> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  } catch {
    return null;
  }
}
function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export class Store {
  readonly tracer: Tracer;
  constructor(
    readonly db: Database,
    readonly leaseMs = 32_000,
  ) {
    this.tracer = new Tracer(db);
  }
  get events() {
    return this.tracer.emit;
  }
  async initialize(): Promise<void> {
    await this.db.query(CORE_SCHEMA);
  }
  async mission(id: string, tx: Sql = this.db): Promise<Mission> {
    const r = await tx.query<Mission>('SELECT * FROM missions WHERE id=$1', [id]);
    invariant(r.rows[0], 'NOT_FOUND', 'Mission does not exist');
    return r.rows[0];
  }
  async lock(tx: Sql, missionId: string): Promise<void> {
    await tx.query('SELECT id FROM missions WHERE id=$1 FOR UPDATE', [missionId]);
  }
  async changed(tx: Sql, missionId: string): Promise<void> {
    await tx.query('UPDATE missions SET revision=revision+1,updated_at=now() WHERE id=$1', [
      missionId,
    ]);
  }
  async createMission(input: {
    id?: string;
    repo: string;
    roadmapPath: string;
    roadmapText: string;
    baseline: unknown;
    agents: number;
    config?: Record<string, unknown>;
  }): Promise<Mission> {
    invariant(
      Number.isInteger(input.agents) && input.agents > 0 && input.agents <= 1000,
      'INVALID_CAPACITY',
      'Agent limit must be between 1 and 1000',
    );
    const id = input.id ?? randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO missions(id,repo,roadmap_path,roadmap_text,roadmap_hash,baseline,config) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          id,
          input.repo,
          input.roadmapPath,
          input.roadmapText,
          hash(input.roadmapText),
          JSON.stringify(input.baseline),
          JSON.stringify({ ...input.config, agents: input.agents }),
        ],
      );
      for (let i = 1; i <= input.agents; i++)
        await tx.query('INSERT INTO slots(mission_id,id) VALUES($1,$2)', [id, `A${i}`]);
      await this.events(
        {
          missionId: id,
          kind: 'mission.created',
          data: {
            repo: input.repo,
            roadmapPath: input.roadmapPath,
            roadmapHash: hash(input.roadmapText),
            roadmapText: input.roadmapText,
            baseline: input.baseline,
            config: { ...input.config, agents: input.agents },
          },
        },
        tx,
      );
    });
    return this.mission(id);
  }
  async assertActive(
    p: Principal,
    tx: Sql = this.db,
    allowClosing = false,
    allowCompleted = false,
  ): Promise<void> {
    const r = await tx.query(
      `SELECT r.id FROM runs r JOIN slots s ON s.mission_id=r.mission_id AND s.id=r.agent_id JOIN missions m ON m.id=r.mission_id
      WHERE r.id=$1 AND r.mission_id=$2 AND r.agent_id=$3 AND r.generation=$4 AND s.generation=r.generation AND s.active_run_id=r.id
      AND r.supervisor_epoch=m.supervisor_epoch AND r.state IN ('starting','running') AND r.lease_expires>now()
      AND m.state=ANY($5::text[])`,
      [
        p.runId,
        p.missionId,
        p.agentId,
        p.generation,
        ['active', ...(allowClosing ? ['closing'] : []), ...(allowCompleted ? ['completed'] : [])],
      ],
    );
    invariant(
      r.rows.length,
      'STALE_RUN',
      'Run is finished, expired, fenced, or mission admission is closed',
    );
  }
  async authenticate(token: string, allowCompleted = false): Promise<Principal> {
    invariant(
      token.length >= 32 && token.length <= 1024,
      'UNAUTHORIZED',
      'A current run bearer credential is required',
    );
    const r = await this.db.query<{
      id: string;
      mission_id: string;
      agent_id: string;
      generation: number;
    }>('SELECT id,mission_id,agent_id,generation FROM runs WHERE token_hash=$1', [hash(token)]);
    invariant(r.rows[0], 'UNAUTHORIZED', 'Invalid bearer credential');
    const row = r.rows[0];
    const p = {
      missionId: row.mission_id,
      agentId: row.agent_id,
      runId: row.id,
      generation: row.generation,
    };
    await this.assertActive(p, this.db, true, allowCompleted);
    return p;
  }
  async acquireSupervisor(input: {
    missionId: string;
    supervisorId: string;
    pid: number;
    hostname: string;
    leaseMs: number;
  }): Promise<{ epoch: number }> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, input.missionId);
      const m = await this.mission(input.missionId, tx);
      invariant(m.state === 'active', 'MISSION_CLOSED', `Mission is ${m.state}`);
      const live = await tx.query(
        "SELECT id FROM runs WHERE mission_id=$1 AND state IN ('starting','running')",
        [input.missionId],
      );
      invariant(
        !live.rows.length,
        'RECOVERY_REQUIRED',
        'Reconcile the previous process population before admitting a supervisor',
      );
      const r = await tx.query<{ supervisor_epoch: number }>(
        `UPDATE missions SET supervisor_epoch=supervisor_epoch+1,supervisor_id=$2,supervisor_pid=$3,supervisor_host=$4,supervisor_lease=now()+$5*interval '1 millisecond' WHERE id=$1 RETURNING supervisor_epoch`,
        [input.missionId, input.supervisorId, input.pid, input.hostname, input.leaseMs],
      );
      const epoch = r.rows[0].supervisor_epoch;
      await this.events(
        { missionId: input.missionId, kind: 'supervisor.acquired', data: { ...input, epoch } },
        tx,
      );
      return { epoch };
    });
  }
  async renewSupervisor(input: {
    missionId: string;
    supervisorId: string;
    epoch: number;
    leaseMs: number;
  }): Promise<void> {
    const r = await this.db.query(
      `UPDATE missions SET supervisor_lease=now()+$4*interval '1 millisecond' WHERE id=$1 AND supervisor_id=$2 AND supervisor_epoch=$3`,
      [input.missionId, input.supervisorId, input.epoch, input.leaseMs],
    );
    invariant(r.rowCount, 'FENCED', 'Supervisor ownership changed');
  }
  async releaseSupervisor(input: {
    missionId: string;
    supervisorId: string;
    epoch: number;
  }): Promise<void> {
    await this.db.query(
      'UPDATE missions SET supervisor_id=NULL,supervisor_lease=NULL WHERE id=$1 AND supervisor_id=$2 AND supervisor_epoch=$3',
      [input.missionId, input.supervisorId, input.epoch],
    );
  }
  async observe(missionId: string): Promise<{ state: MissionState; workRevision: string }> {
    const m = await this.mission(missionId);
    return { state: m.state, workRevision: String(m.revision) };
  }
  async waitForRevision(
    missionId: string,
    afterRevision: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ state: MissionState; workRevision: string }> {
    const until = Date.now() + timeoutMs;
    while (true) {
      const state = await this.observe(missionId);
      if (
        state.workRevision !== afterRevision ||
        state.state !== 'active' ||
        Date.now() >= until ||
        signal?.aborted
      )
        return state;
      await delay(Math.min(500, until - Date.now()), undefined, { signal }).catch((error) => {
        if (!signal?.aborted) throw error;
      });
    }
  }
  async allocateRun(input: {
    missionId: string;
    agentId: string;
    supervisorId: string;
    epoch: number;
  }): Promise<{ principal: Principal; token: string }> {
    const token = randomBytes(32).toString('base64url');
    registerSecret(token);
    const principal = await this.db.transaction(async (tx) => {
      await this.lock(tx, input.missionId);
      const valid = await tx.query(
        "SELECT id FROM missions WHERE id=$1 AND state='active' AND supervisor_id=$2 AND supervisor_epoch=$3 AND supervisor_lease>now()",
        [input.missionId, input.supervisorId, input.epoch],
      );
      invariant(valid.rowCount, 'FENCED', 'Supervisor cannot admit this run');
      const slot = await tx.query<{ generation: number; active_run_id: string | null }>(
        'SELECT generation,active_run_id FROM slots WHERE mission_id=$1 AND id=$2 FOR UPDATE',
        [input.missionId, input.agentId],
      );
      invariant(slot.rows[0], 'UNKNOWN_AGENT', 'Agent slot is outside this mission capacity');
      invariant(!slot.rows[0].active_run_id, 'SLOT_BUSY', 'A run already owns this slot');
      const p = {
        missionId: input.missionId,
        agentId: input.agentId,
        runId: randomUUID(),
        generation: slot.rows[0].generation + 1,
      };
      await tx.query(
        `INSERT INTO runs(id,mission_id,agent_id,generation,supervisor_epoch,token_hash,lease_expires) VALUES($1,$2,$3,$4,$5,$6,now()+$7*interval '1 millisecond')`,
        [p.runId, p.missionId, p.agentId, p.generation, input.epoch, hash(token), this.leaseMs],
      );
      await tx.query(
        "UPDATE slots SET generation=$3,active_run_id=$4,state='starting' WHERE mission_id=$1 AND id=$2",
        [p.missionId, p.agentId, p.generation, p.runId],
      );
      await this.events(
        {
          ...p,
          kind: 'run.allocated',
          correlationId: p.runId,
          data: { supervisorEpoch: input.epoch, generation: p.generation },
        },
        tx,
      );
      return p;
    });
    return { principal, token };
  }
  async setPid(p: Principal, pid: number, logDir?: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      await tx.query(
        "UPDATE runs SET pid=$2,pid_start=$3,log_dir=$4,pid_boot=$5,state='running' WHERE id=$1",
        [p.runId, pid, await processStart(pid), logDir ?? null, await processBoot()],
      );
      await tx.query(
        "UPDATE slots SET state='running' WHERE mission_id=$1 AND id=$2 AND active_run_id=$3",
        [p.missionId, p.agentId, p.runId],
      );
    });
  }
  async heartbeat(p: Principal): Promise<void> {
    const r = await this.db.query(
      `UPDATE runs SET heartbeat_at=now(),lease_expires=now()+$5*interval '1 millisecond'
      WHERE id=$1 AND mission_id=$2 AND agent_id=$3 AND generation=$4 AND state IN ('starting','running')
      AND supervisor_epoch=(SELECT supervisor_epoch FROM missions WHERE id=$2)`,
      [p.runId, p.missionId, p.agentId, p.generation, this.leaseMs],
    );
    invariant(r.rowCount, 'STALE_RUN', 'Run heartbeat was fenced');
  }
  async endRun(
    p: Principal,
    result: {
      status: string;
      exitCode: number | null;
      signal: string | null;
      result: unknown;
      error?: string;
      reaped: boolean;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await tx.query(
        'UPDATE runs SET state=$2,ended_at=now(),lease_expires=now(),result=$3::jsonb,reason=$4 WHERE id=$1',
        [
          p.runId,
          result.reaped ? result.status : 'quarantined',
          JSON.stringify(result.result),
          result.error ?? result.status,
        ],
      );
      await tx.query(
        'UPDATE slots SET state=$4,active_run_id=$5,handoff=COALESCE($6::jsonb,handoff) WHERE mission_id=$1 AND id=$2 AND active_run_id=$3',
        [
          p.missionId,
          p.agentId,
          p.runId,
          result.reaped ? 'parked' : 'quarantined',
          result.reaped ? null : p.runId,
          JSON.stringify(result.result),
        ],
      );
      await tx.query(
        "UPDATE knowledge SET readiness='parked' WHERE mission_id=$1 AND agent_id=$2 AND readiness='warm'",
        [p.missionId, p.agentId],
      );
      const released = await tx.query(
        "UPDATE claims SET state=$2,released_at=CASE WHEN $2='released' THEN now() ELSE NULL END WHERE run_id=$1 AND state='held'",
        [p.runId, result.reaped ? 'released' : 'quarantined'],
      );
      const parked = await tx.query(
        "UPDATE intentions SET state='parked' WHERE run_id=$1 AND state='active'",
        [p.runId],
      );
      if (released.rowCount || parked.rowCount) await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'run.ended', data: result }, tx);
    });
  }
  async stopMission(
    missionId: string,
    state: 'stopped' | 'resource-limit' | 'stalled',
    reason: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, missionId);
      const r = await tx.query(
        "UPDATE missions SET state=$2,revision=revision+1 WHERE id=$1 AND state<>'completed'",
        [missionId, state],
      );
      if (r.rowCount)
        await this.events({ missionId, kind: 'mission.stopped', data: { state, reason } }, tx);
    });
  }
  /** Called only by the operator while holding this checkout's OS writer lock. */
  async recoverRuns(missionId: string): Promise<void> {
    const m = await this.db.query<{ supervisor_host: string | null }>(
      'SELECT supervisor_host FROM missions WHERE id=$1',
      [missionId],
    );
    const r = await this.db.query<{
      id: string;
      agent_id: string;
      generation: number;
      pid: number | null;
      pid_start: string | null;
      pid_boot: string | null;
    }>(
      "SELECT id,agent_id,generation,pid,pid_start,pid_boot FROM runs WHERE mission_id=$1 AND state IN ('starting','running','quarantined')",
      [missionId],
    );
    for (const row of r.rows) {
      invariant(
        !row.pid || m.rows[0]?.supervisor_host === hostname(),
        'RECOVERY_REQUIRED',
        'Previous worker belongs to another host; confirm it is stopped before recovery',
      );
      if (row.pid) {
        const current = await processStart(row.pid);
        invariant(
          !current || row.pid_start,
          'RECOVERY_REQUIRED',
          'Worker process identity was not durably recorded; inspect it before recovery',
        );
        const sameBoot = row.pid_boot === (await processBoot());
        if (
          sameBoot &&
          ((current && current === row.pid_start) || (!current && groupExists(row.pid)))
        ) {
          try {
            process.kill(-row.pid, 'SIGTERM');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          await delay(250);
          if (groupExists(row.pid)) {
            try {
              process.kill(-row.pid, 'SIGKILL');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
          for (let i = 0; i < 30 && groupExists(row.pid); i++) await delay(100);
          invariant(
            !groupExists(row.pid),
            'RECOVERY_REQUIRED',
            'Cannot confirm previous worker process group termination',
          );
        }
      }
      await this.endRun(
        { missionId, agentId: row.agent_id, runId: row.id, generation: row.generation },
        {
          status: 'aborted',
          exitCode: null,
          signal: null,
          result: null,
          error: 'Recovered after supervisor interruption',
          reaped: true,
        },
      );
    }
  }
  async claim(p: Principal, input: ClaimInput): Promise<unknown> {
    const resources = [...new Set(input.resources.map(normalizeResource))].sort();
    invariant(
      resources.length > 0 && resources.length <= 200,
      'INVALID_CLAIM',
      'Claim between 1 and 200 resources',
    );
    return this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      const prior = await tx.query<{ run_id: string; resources: string[] }>(
        'SELECT * FROM claims WHERE mission_id=$1 AND id=$2',
        [p.missionId, input.id],
      );
      if (prior.rows[0]) {
        invariant(
          prior.rows[0].run_id === p.runId &&
            canonicalJson(prior.rows[0].resources) === canonicalJson(resources),
          'IDEMPOTENCY_CONFLICT',
          'Claim ID was used for different input',
        );
        return prior.rows[0];
      }
      const held = await tx.query<{
        id: string;
        agent_id: string;
        run_id: string;
        resources: string[];
        state: string;
      }>("SELECT * FROM claims WHERE mission_id=$1 AND state IN ('held','quarantined')", [
        p.missionId,
      ]);
      const conflicts = held.rows.filter(
        (c) =>
          c.run_id !== p.runId && c.resources.some((a) => resources.some((b) => overlaps(a, b))),
      );
      if (conflicts.length) {
        await this.events(
          {
            ...p,
            kind: 'claim.conflict',
            data: {
              requested: resources,
              conflicts: conflicts.map((c) => ({
                id: c.id,
                agent: c.agent_id,
                resources: c.resources,
                state: c.state,
              })),
            },
          },
          tx,
        );
        return { granted: false, conflicts };
      }
      if (input.intentionId) {
        const existing = await tx.query<{ state: string; owner_agent: string }>(
          'SELECT state,owner_agent FROM intentions WHERE mission_id=$1 AND id=$2',
          [p.missionId, input.intentionId],
        );
        invariant(
          !existing.rows[0] ||
            existing.rows[0].state === 'parked' ||
            existing.rows[0].owner_agent === p.agentId,
          'INTENTION_BUSY',
          'Intention has a live custodian',
        );
        await tx.query(
          `INSERT INTO intentions(mission_id,id,owner_agent,run_id,requirement_ids,description) VALUES($1,$2,$3,$4,$5::jsonb,$6)
          ON CONFLICT(mission_id,id) DO UPDATE SET owner_agent=$3,run_id=$4,state='active',revision=intentions.revision+1`,
          [
            p.missionId,
            input.intentionId,
            p.agentId,
            p.runId,
            JSON.stringify(input.requirementIds ?? []),
            input.description,
          ],
        );
      }
      await tx.query(
        'INSERT INTO claims(mission_id,id,intention_id,agent_id,run_id,generation,resources) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
        [
          p.missionId,
          input.id,
          input.intentionId ?? null,
          p.agentId,
          p.runId,
          p.generation,
          JSON.stringify(resources),
        ],
      );
      await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'claim.granted', data: { ...input, resources } }, tx);
      return { granted: true, id: input.id, resources };
    });
  }
  async authorize(
    p: Principal,
    paths: string[],
    operationId: string,
    claimId?: string,
    dependencies?: Dependencies,
  ): Promise<void> {
    await this.assertActive(p);
    const claims = await this.db.query<{ resources: string[] }>(
      "SELECT resources FROM claims WHERE mission_id=$1 AND run_id=$2 AND generation=$3 AND state='held' AND ($4::text IS NULL OR id=$4)",
      [p.missionId, p.runId, p.generation, claimId ?? null],
    );
    invariant(
      paths.every((path) => claims.rows.some((c) => c.resources.some((r) => covers(r, path)))),
      'CLAIM_REQUIRED',
      'Every changed path requires a current claim',
    );
    for (const [id, revision] of Object.entries(dependencies?.decisions ?? {})) {
      const r = await this.db.query(
        "SELECT id FROM knowledge WHERE mission_id=$1 AND id=$2 AND revision=$3 AND freshness='current'",
        [p.missionId, id, revision],
      );
      invariant(r.rowCount, 'STALE_DEPENDENCY', `Decision ${id} changed or became stale`);
    }
  }
  async board(
    p: Principal,
    query?: string,
    page: { knowledgeLimit?: number; knowledgeCursor?: { updatedAt: string; id: string } } = {},
  ): Promise<unknown> {
    await this.assertActive(p, this.db, true);
    const limit = page.knowledgeLimit ?? 50;
    invariant(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_LIMIT',
      'knowledgeLimit must be between 1 and 100',
    );
    const m = await this.mission(p.missionId);
    const [requirements, intentions, claims, knowledge, peers, summary] = await Promise.all([
      this.db.query('SELECT * FROM requirements WHERE mission_id=$1 ORDER BY id LIMIT 200', [
        p.missionId,
      ]),
      this.db.query('SELECT * FROM intentions WHERE mission_id=$1 ORDER BY id LIMIT 200', [
        p.missionId,
      ]),
      this.db.query(
        "SELECT * FROM claims WHERE mission_id=$1 AND state IN ('held','quarantined') LIMIT 200",
        [p.missionId],
      ),
      this.db.query(
        `SELECT *, updated_at::text AS cursor_time FROM knowledge WHERE mission_id=$1
         AND ($2::text IS NULL OR to_tsvector('english',title||' '||body) @@ plainto_tsquery('english',$2))
         AND ($3::timestamptz IS NULL OR (updated_at,id) < ($3::timestamptz,$4::text))
         ORDER BY updated_at DESC,id DESC LIMIT $5`,
        [
          p.missionId,
          query || null,
          page.knowledgeCursor?.updatedAt ?? null,
          page.knowledgeCursor?.id ?? null,
          limit + 1,
        ],
      ),
      this.db.query(
        'SELECT id,generation,state,handoff FROM slots WHERE mission_id=$1 ORDER BY id',
        [p.missionId],
      ),
      this.db.query(
        `SELECT count(*) AS total,
         count(*) FILTER (WHERE kind='finding') AS findings,
         count(*) FILTER (WHERE kind='decision') AS decisions,
         count(*) FILTER (WHERE kind='offer') AS offers,
         count(*) FILTER (WHERE kind='blocker') AS blockers,
         count(*) FILTER (WHERE status='resolved') AS resolved,
         count(*) FILTER (WHERE freshness='stale') AS stale
         FROM knowledge WHERE mission_id=$1
         AND ($2::text IS NULL OR to_tsvector('english',title||' '||body) @@ plainto_tsquery('english',$2))`,
        [p.missionId, query || null],
      ),
    ]);
    const entries = knowledge.rows.slice(0, limit);
    const hasMore = knowledge.rows.length > limit;
    const last = entries.at(-1);
    await this.observed(p, String(m.revision));
    return {
      mission: {
        id: m.id,
        state: m.state,
        revision: String(m.revision),
        roadmapPath: m.roadmap_path,
        roadmapHash: m.roadmap_hash,
      },
      requirements: requirements.rows,
      intentions: intentions.rows,
      claims: claims.rows,
      knowledge: entries.map(({ cursor_time, ...entry }) => entry),
      knowledgePage: {
        limit,
        hasMore,
        nextCursor: hasMore && last ? { updatedAt: last.cursor_time, id: last.id } : null,
        summary: Object.fromEntries(
          Object.entries(summary.rows[0]).map(([key, value]) => [key, Number(value)]),
        ),
      },
      peers: peers.rows,
    };
  }
  async observed(p: Principal, revision: string): Promise<void> {
    await this.db.query(
      'UPDATE runs SET observed_revision=GREATEST(COALESCE(observed_revision,-1),$2::bigint) WHERE id=$1',
      [p.runId, revision],
    );
  }
  async checkpoint(p: Principal, body: unknown, id = randomUUID()): Promise<{ id: string }> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      // Final audit metadata may be saved during the bounded completion drain.
      await this.assertActive(p, tx, false, true);
      const prior = await tx.query<{ body: unknown; run_id: string }>(
        'SELECT body,run_id FROM checkpoints WHERE id=$1',
        [id],
      );
      if (prior.rows[0]) {
        invariant(
          prior.rows[0].run_id === p.runId &&
            canonicalJson(prior.rows[0].body) === canonicalJson(body),
          'IDEMPOTENCY_CONFLICT',
          'Checkpoint ID reused',
        );
        return;
      }
      await tx.query(
        'INSERT INTO checkpoints(id,mission_id,agent_id,run_id,body) VALUES($1,$2,$3,$4,$5::jsonb)',
        [id, p.missionId, p.agentId, p.runId, JSON.stringify(body)],
      );
      await tx.query('UPDATE slots SET handoff=$3::jsonb WHERE mission_id=$1 AND id=$2', [
        p.missionId,
        p.agentId,
        JSON.stringify(body),
      ]);
      await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'checkpoint.recorded', data: { id, body } }, tx);
    });
    return { id };
  }
  async yield(
    p: Principal,
    reason: string,
    waitingOn: string[] = [],
  ): Promise<{ workRevision: string }> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      const before = await this.mission(p.missionId, tx);
      const seen = await tx.query<{ observed_revision: string | null }>(
        'SELECT observed_revision FROM runs WHERE id=$1',
        [p.runId],
      );
      const released = await tx.query(
        "UPDATE claims SET state='released',released_at=now() WHERE run_id=$1 AND state='held'",
        [p.runId],
      );
      const parked = await tx.query(
        "UPDATE intentions SET state='parked',waiting_on=$2::jsonb WHERE run_id=$1 AND (state<>'parked' OR waiting_on<>$2::jsonb)",
        [p.runId, JSON.stringify(waitingOn)],
      );
      if (released.rowCount || parked.rowCount) await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'run.yielded', data: { reason, waitingOn } }, tx);
      const after = await this.mission(p.missionId, tx);
      const observed = seen.rows[0]?.observed_revision;
      return {
        workRevision:
          observed === null || observed === undefined
            ? '-1'
            : BigInt(observed) < BigInt(before.revision)
              ? String(observed)
              : String(after.revision),
      };
    });
  }
  async remember(
    p: Principal,
    input: {
      id: string;
      kind: 'finding' | 'decision' | 'offer' | 'blocker';
      title: string;
      body: string;
      expectedRevision?: number;
      evidence?: unknown;
      conditions?: unknown[];
      unknowns?: unknown[];
      readiness?: 'warm' | 'parked' | 'unavailable';
      status?: 'open' | 'resolved';
      edges?: { toId: string; toRevision: number; kind: string }[];
    },
  ): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      const prior = await tx.query<{ revision: number }>(
        'SELECT * FROM knowledge WHERE mission_id=$1 AND id=$2',
        [p.missionId, input.id],
      );
      invariant(
        prior.rows[0]
          ? prior.rows[0].revision === input.expectedRevision
          : input.expectedRevision === undefined || input.expectedRevision === 0,
        'REVISION_CONFLICT',
        'Provide the current knowledge revision',
      );
      const revision = (prior.rows[0]?.revision ?? 0) + 1;
      if (prior.rows[0])
        await tx.query(
          'INSERT INTO knowledge_history(mission_id,id,revision,snapshot) VALUES($1,$2,$3,$4::jsonb)',
          [p.missionId, input.id, revision - 1, JSON.stringify(prior.rows[0])],
        );
      await tx.query(
        `INSERT INTO knowledge(mission_id,id,revision,kind,title,body,agent_id,run_id,evidence,conditions,unknowns,readiness,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
        ON CONFLICT(mission_id,id) DO UPDATE SET revision=$3,kind=$4,title=$5,body=$6,agent_id=$7,run_id=$8,evidence=$9::jsonb,conditions=$10::jsonb,unknowns=$11::jsonb,readiness=$12,status=$13,freshness='current',updated_at=now()`,
        [
          p.missionId,
          input.id,
          revision,
          input.kind,
          input.title,
          input.body,
          p.agentId,
          p.runId,
          JSON.stringify(input.evidence ?? {}),
          JSON.stringify(input.conditions ?? []),
          JSON.stringify(input.unknowns ?? []),
          input.readiness ?? 'warm',
          input.status ?? 'open',
        ],
      );
      for (const edge of input.edges ?? []) {
        invariant(
          ['supports', 'challenges', 'depends-on', 'supersedes', 'affects', 'answers'].includes(
            edge.kind,
          ),
          'INVALID_EDGE',
          'Unknown knowledge relation',
        );
        const target = await tx.query(
          'SELECT id FROM knowledge WHERE mission_id=$1 AND id=$2 AND revision=$3',
          [p.missionId, edge.toId, edge.toRevision],
        );
        invariant(target.rowCount, 'STALE_DEPENDENCY', 'Edge target revision does not exist');
        await tx.query(
          'INSERT INTO knowledge_edges(mission_id,from_id,from_revision,to_id,to_revision,kind) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [p.missionId, input.id, revision, edge.toId, edge.toRevision, edge.kind],
        );
      }
      if (prior.rows[0]) {
        const affected = await tx.query<{ id: string; agent_id: string }>(
          `WITH RECURSIVE affected(id) AS (
          SELECT from_id FROM knowledge_edges WHERE mission_id=$1 AND to_id=$2 AND to_revision<$3 AND kind IN ('depends-on','supports')
          UNION SELECT e.from_id FROM knowledge_edges e JOIN affected a ON e.to_id=a.id WHERE e.mission_id=$1 AND e.kind IN ('depends-on','supports'))
          UPDATE knowledge SET freshness='stale' WHERE mission_id=$1 AND id IN (SELECT id FROM affected) AND id<>$2 RETURNING id,agent_id`,
          [p.missionId, input.id, revision],
        );
        if (affected.rowCount)
          await this.events(
            {
              ...p,
              kind: 'knowledge.invalidated',
              data: { sourceId: input.id, revision, affected: affected.rows },
            },
            tx,
          );
      }
      await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'knowledge.recorded', data: { ...input, revision } }, tx);
      return { id: input.id, revision };
    });
  }
  async invalidateFiles(missionId: string, files: string[], transaction?: Sql): Promise<void> {
    const update = async (tx: Sql) => {
      await this.lock(tx, missionId);
      const r = await tx.query<{ id: string; evidence: { files?: Record<string, unknown> } }>(
        "SELECT id,evidence FROM knowledge WHERE mission_id=$1 AND freshness='current'",
        [missionId],
      );
      const stale = r.rows
        .filter((k) =>
          files.includes('*')
            ? Object.keys(k.evidence?.files ?? {}).length > 0
            : files.some((f) => Object.hasOwn(k.evidence?.files ?? {}, f)),
        )
        .map((k) => k.id);
      if (stale.length) {
        await tx.query(
          `WITH RECURSIVE affected(id) AS (SELECT unnest($2::text[]) UNION SELECT e.from_id FROM knowledge_edges e JOIN affected a ON e.to_id=a.id WHERE e.mission_id=$1 AND e.kind IN ('depends-on','supports')) UPDATE knowledge SET freshness='stale' WHERE mission_id=$1 AND id IN (SELECT id FROM affected)`,
          [missionId, stale],
        );
        await this.events(
          { missionId, kind: 'knowledge.invalidated', data: { files, ids: stale } },
          tx,
        );
      }
      await this.changed(tx, missionId);
    };
    if (transaction) await update(transaction);
    else await this.db.transaction(update);
  }
  async requirement(
    p: Principal,
    input: {
      id: string;
      anchor: string;
      title: string;
      criteria: string[];
      expectedRevision?: number;
      state?: 'open' | 'implemented';
      evidence?: unknown[];
    },
  ): Promise<unknown> {
    return this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      const m = await this.mission(p.missionId, tx);
      invariant(
        input.anchor.length > 0 && m.roadmap_text.includes(input.anchor),
        'INVALID_ANCHOR',
        'Requirement anchor must appear in the original roadmap',
      );
      invariant(input.criteria.length > 0, 'NO_CRITERIA', 'Acceptance criteria are required');
      const old = await tx.query<{
        revision: number;
        anchor: string;
        title: string;
        criteria: string[];
        state: string;
        evidence: unknown[];
      }>(
        'SELECT revision,anchor,title,criteria,state,evidence FROM requirements WHERE mission_id=$1 AND id=$2',
        [p.missionId, input.id],
      );
      invariant(
        old.rows[0] ? old.rows[0].revision === input.expectedRevision : !input.expectedRevision,
        'REVISION_CONFLICT',
        'Provide the current requirement revision',
      );
      const revision = (old.rows[0]?.revision ?? 0) + 1;
      invariant(
        input.state !== 'implemented' || (input.evidence ?? []).length > 0,
        'EVIDENCE_REQUIRED',
        'Implementation needs evidence',
      );
      const previous = old.rows[0];
      if (
        previous &&
        canonicalJson({
          anchor: input.anchor,
          title: input.title,
          criteria: input.criteria,
          state: input.state ?? 'open',
          evidence: input.evidence ?? [],
        }) ===
          canonicalJson({
            anchor: previous.anchor,
            title: previous.title,
            criteria: previous.criteria,
            state: previous.state,
            evidence: previous.evidence,
          })
      )
        return { id: input.id, revision: previous.revision, unchanged: true };
      await tx.query(
        `INSERT INTO requirements(mission_id,id,revision,anchor,title,criteria,state,author_agent,evidence) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb)
        ON CONFLICT(mission_id,id) DO UPDATE SET revision=$3,anchor=$4,title=$5,criteria=$6::jsonb,state=$7,author_agent=$8,evidence=$9::jsonb,updated_at=now()`,
        [
          p.missionId,
          input.id,
          revision,
          input.anchor,
          input.title,
          JSON.stringify(input.criteria),
          input.state ?? 'open',
          p.agentId,
          JSON.stringify(input.evidence ?? []),
        ],
      );
      await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'requirement.recorded', data: { ...input, revision } }, tx);
      return { id: input.id, revision };
    });
  }
  async review(
    p: Principal,
    input: {
      id: string;
      kind: 'requirement' | 'coverage';
      targetId?: string;
      targetRevision?: number;
      manifestHash: string;
      verdict: 'pass' | 'objection';
      reasoning: string;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, p.missionId);
      await this.assertActive(p, tx);
      const m = await this.mission(p.missionId, tx);
      if (input.kind === 'requirement') {
        const r = await tx.query<{ author_agent: string }>(
          'SELECT author_agent FROM requirements WHERE mission_id=$1 AND id=$2 AND revision=$3',
          [p.missionId, input.targetId, input.targetRevision],
        );
        invariant(r.rowCount, 'STALE_REVIEW', 'Requirement revision does not exist');
        invariant(
          r.rows[0].author_agent !== p.agentId,
          'INDEPENDENT_REVIEW',
          'A different peer must review the requirement',
        );
      }
      const coverage =
        input.kind === 'coverage'
          ? manifestHash(
              (
                await tx.query(
                  'SELECT id,revision FROM requirements WHERE mission_id=$1 ORDER BY id',
                  [p.missionId],
                )
              ).rows,
            )
          : null;
      await tx.query(
        'INSERT INTO reviews(id,mission_id,agent_id,run_id,kind,target_id,target_revision,roadmap_hash,manifest_hash,coverage_hash,verdict,reasoning) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [
          input.id,
          p.missionId,
          p.agentId,
          p.runId,
          input.kind,
          input.targetId ?? null,
          input.targetRevision ?? null,
          m.roadmap_hash,
          input.manifestHash,
          coverage,
          input.verdict,
          input.reasoning,
        ],
      );
      await this.changed(tx, p.missionId);
      await this.events({ ...p, kind: 'review.recorded', data: input }, tx);
    });
  }
}
