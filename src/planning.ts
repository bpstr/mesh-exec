import type { Store } from './store.js';
import { canonicalJson, normalizeResource, overlaps } from './store.js';
import { invariant, type Principal, type Sql } from './types.js';

export interface WorkItem {
  id: string;
  title: string;
  resources: string[];
  requirementIds: string[];
  requires?: Record<string, number>;
  expectedRevision?: number;
}
interface Row {
  id: string;
  title: string;
  resources: string[];
  requirement_ids: string[];
  requires: Record<string, number>;
  revision: number;
}

/** Peer-authored work boundaries, not an LLM dispatcher or an acceptance authority. */
export async function workState(db: Sql, missionId: string) {
  const [items, requirements, claims] = await Promise.all([
    db.query<Row>('SELECT * FROM work_items WHERE mission_id=$1 ORDER BY id', [missionId]),
    db.query<{ id: string; revision: number; state: string }>(
      'SELECT id,revision,state FROM requirements WHERE mission_id=$1',
      [missionId],
    ),
    db.query<{ resources: string[]; work_id: string | null; agent_id: string }>(
      "SELECT resources,work_id,agent_id FROM claims WHERE mission_id=$1 AND state IN ('held','quarantined')",
      [missionId],
    ),
  ]);
  const known = new Map(requirements.rows.map((r) => [r.id, r]));
  const rows = items.rows.map((item) => {
    const blockedBy = Object.entries(item.requires)
      .filter(([id, revision]) => {
        const r = known.get(id);
        return !r || r.revision !== revision || r.state !== 'implemented';
      })
      .map(([id]) => id);
    const owners = [
      ...new Set(
        claims.rows
          .filter((c) => c.resources.some((a) => item.resources.some((b) => overlaps(a, b))))
          .map((c) => c.agent_id),
      ),
    ];
    const complete = item.requirement_ids.every((id) => known.get(id)?.state === 'implemented');
    return {
      ...item,
      blockedBy,
      owners,
      state: complete
        ? 'implemented'
        : blockedBy.length
          ? 'blocked'
          : owners.length
            ? 'claimed'
            : 'ready',
    };
  });
  // A conservative disjoint frontier avoids treating two bundles on the same
  // SDK files as two independent implementation opportunities.
  const frontier: string[] = [];
  const resources: string[] = [];
  for (const row of rows) {
    if (row.state !== 'ready' || row.resources.some((r) => resources.some((s) => overlaps(r, s))))
      continue;
    frontier.push(row.id);
    resources.push(...row.resources);
  }
  const activeOwners = new Set(claims.rows.map((c) => c.agent_id)).size;
  return {
    items: rows,
    independentReadyIds: frontier,
    admissionLimit: rows.length ? Math.max(2, activeOwners + frontier.length + 1) : null,
  };
}

export async function declareWork(store: Store, p: Principal, items: WorkItem[]) {
  invariant(
    Buffer.byteLength(JSON.stringify(items), 'utf8') <= 65_536,
    'WORK_PLAN_TOO_LARGE',
    'Declare work in batches under 64 KiB',
  );
  invariant(
    items.length > 0 &&
      items.length <= 100 &&
      new Set(items.map((i) => i.id)).size === items.length,
    'INVALID_WORK_PLAN',
    'Declare between 1 and 100 distinct work bundles',
  );
  return store.db.transaction(async (tx) => {
    await store.lock(tx, p.missionId);
    await store.assertActive(p, tx);
    const result: { id: string; revision: number; unchanged: boolean }[] = [];
    for (const item of items) {
      const resources = [...new Set(item.resources.map(normalizeResource))].sort();
      invariant(
        resources.length > 0 && item.requirementIds.length > 0,
        'INVALID_WORK_PLAN',
        'A bundle needs resources and target requirements',
      );
      const targets = [...new Set(item.requirementIds)].sort();
      const requires = item.requires ?? {};
      const ids = [...new Set([...targets, ...Object.keys(requires)])];
      const known = await tx.query<{ id: string; revision: number }>(
        'SELECT id,revision FROM requirements WHERE mission_id=$1 AND id=ANY($2::text[])',
        [p.missionId, ids],
      );
      invariant(
        known.rows.length === ids.length &&
          known.rows.every(
            (r) =>
              requires[r.id] === undefined ||
              (requires[r.id] === r.revision && !targets.includes(r.id)),
          ),
        'INVALID_WORK_DEPENDENCY',
        'Prerequisites must reference current, distinct requirement revisions',
      );
      const prior = (
        await tx.query<Row>('SELECT * FROM work_items WHERE mission_id=$1 AND id=$2', [
          p.missionId,
          item.id,
        ])
      ).rows[0];
      const same =
        prior &&
        canonicalJson([prior.title, prior.resources, prior.requirement_ids, prior.requires]) ===
          canonicalJson([item.title, resources, targets, requires]);
      if (same) {
        result.push({ id: item.id, revision: prior.revision, unchanged: true });
        continue;
      }
      invariant(
        !prior || prior.revision === item.expectedRevision,
        'STALE_WORK_PLAN',
        'Read the current bundle revision before changing it',
      );
      const held = await tx.query(
        "SELECT id FROM claims WHERE mission_id=$1 AND work_id=$2 AND state IN ('held','quarantined')",
        [p.missionId, item.id],
      );
      invariant(!held.rowCount, 'WORK_BUSY', 'Release the bundle before changing its boundaries');
      const revision = (prior?.revision ?? 0) + 1;
      await tx.query(
        `INSERT INTO work_items(mission_id,id,title,resources,requirement_ids,requires,revision) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7)
        ON CONFLICT(mission_id,id) DO UPDATE SET title=$3,resources=$4::jsonb,requirement_ids=$5::jsonb,requires=$6::jsonb,revision=$7`,
        [
          p.missionId,
          item.id,
          item.title,
          JSON.stringify(resources),
          JSON.stringify(targets),
          JSON.stringify(requires),
          revision,
        ],
      );
      result.push({ id: item.id, revision, unchanged: false });
    }
    const plan = (
      await tx.query<Row>('SELECT * FROM work_items WHERE mission_id=$1', [p.missionId])
    ).rows;
    invariant(plan.length <= 1000, 'WORK_PLAN_LIMIT', 'At most 1000 work bundles are supported');
    const owners = new Map<string, string>();
    for (const item of plan)
      for (const target of item.requirement_ids) {
        invariant(
          !owners.has(target),
          'DUPLICATE_WORK_TARGET',
          'Each target requirement must belong to one work bundle',
        );
        owners.set(target, item.id);
      }
    const visited = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string): void => {
      invariant(!visiting.has(id), 'WORK_CYCLE', 'Work prerequisites contain a cycle');
      if (visited.has(id)) return;
      visiting.add(id);
      for (const requirement of Object.keys(plan.find((i) => i.id === id)!.requires)) {
        const owner = owners.get(requirement);
        if (owner) visit(owner);
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const item of plan) visit(item.id);
    if (result.some((r) => !r.unchanged)) {
      await tx.query('UPDATE missions SET revision=revision+1 WHERE id=$1', [p.missionId]);
      await store.events({ ...p, kind: 'work.plan.updated', data: { items: result } }, tx);
    }
    return { items: result };
  });
}

export async function checkWorkClaim(
  db: Sql,
  missionId: string,
  workId: string | undefined,
  resources: string[],
  allowImplemented = false,
) {
  const state = await workState(db, missionId);
  if (!state.items.length && !workId) return;
  invariant(
    workId || resources.every((r) => r.startsWith('resource:')),
    'WORK_ID_REQUIRED',
    'Select a ready bundle with mesh_work before claiming implementation files',
  );
  if (!workId) return;
  const item = state.items.find((i) => i.id === workId);
  invariant(item, 'UNKNOWN_WORK', 'No such work bundle');
  invariant(
    (allowImplemented || item.state !== 'implemented') && !item.blockedBy.length,
    'WORK_BLOCKED',
    `Work is implemented or waiting on prerequisites: ${item.blockedBy.join(', ')}`,
  );
  invariant(
    canonicalJson([...resources].sort()) === canonicalJson([...item.resources].sort()),
    'WORK_RESOURCES',
    'Claim the complete declared bundle; split its plan to work independently',
  );
}
