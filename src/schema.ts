export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS mesh_schema (version integer PRIMARY KEY, installed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS missions (
  id text PRIMARY KEY, repo text NOT NULL, roadmap_path text NOT NULL, roadmap_text text NOT NULL,
  roadmap_hash text NOT NULL, baseline jsonb NOT NULL, config jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'active', revision bigint NOT NULL DEFAULT 0,
  next_event_seq bigint NOT NULL DEFAULT 0, supervisor_epoch integer NOT NULL DEFAULT 0,
  supervisor_id text, supervisor_pid integer, supervisor_host text, supervisor_lease timestamptz,
  acceptance jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_mission_per_repo ON missions(repo) WHERE state IN ('active','closing');
CREATE TABLE IF NOT EXISTS slots (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL, generation integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'parked', active_run_id text, handoff jsonb, observed_revision bigint NOT NULL DEFAULT -1,
  PRIMARY KEY(mission_id,id)
);
CREATE TABLE IF NOT EXISTS runs (
  id text PRIMARY KEY, mission_id text NOT NULL REFERENCES missions(id), agent_id text NOT NULL, generation integer NOT NULL,
  supervisor_epoch integer NOT NULL, token_hash text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'starting',
  pid integer, pid_start text, pid_boot text, lease_expires timestamptz NOT NULL, last_activity_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz,
  reason text, handoff jsonb, log_dir text, result jsonb, observed_revision bigint,
  UNIQUE(mission_id,agent_id,generation), FOREIGN KEY(mission_id,agent_id) REFERENCES slots(mission_id,id)
);
CREATE INDEX IF NOT EXISTS runs_mission ON runs(mission_id,started_at);
CREATE TABLE IF NOT EXISTS trace_events (
  id text PRIMARY KEY, mission_id text NOT NULL REFERENCES missions(id), seq bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL, agent_id text, run_id text,
  trace_id text, span_id text, parent_span_id text, correlation_id text, causation_id text,
  message_id text, task_id text, operation_id text, data jsonb NOT NULL DEFAULT '{}', UNIQUE(mission_id,seq)
);
CREATE INDEX IF NOT EXISTS trace_runs ON trace_events(mission_id,run_id,seq);
CREATE INDEX IF NOT EXISTS trace_messages ON trace_events(mission_id,message_id,seq);
CREATE INDEX IF NOT EXISTS trace_tasks ON trace_events(mission_id,task_id,seq);
CREATE INDEX IF NOT EXISTS trace_correlation ON trace_events(mission_id,correlation_id,seq);
CREATE INDEX IF NOT EXISTS trace_trace_id ON trace_events(mission_id,trace_id,seq);
CREATE INDEX IF NOT EXISTS trace_spans ON trace_events(mission_id,span_id,seq);
CREATE TABLE IF NOT EXISTS requirements (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL, revision integer NOT NULL DEFAULT 1,
  anchor text NOT NULL, title text NOT NULL, criteria jsonb NOT NULL, state text NOT NULL DEFAULT 'open',
  author_agent text NOT NULL, evidence jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,id)
);
CREATE TABLE IF NOT EXISTS intentions (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL, owner_agent text NOT NULL, run_id text NOT NULL,
  requirement_ids jsonb NOT NULL, description text NOT NULL, state text NOT NULL DEFAULT 'active',
  waiting_on jsonb NOT NULL DEFAULT '[]', handoff jsonb, revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(mission_id,id)
);
CREATE TABLE IF NOT EXISTS claims (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL, intention_id text,
  agent_id text NOT NULL, run_id text NOT NULL, generation integer NOT NULL, resources jsonb NOT NULL,
  state text NOT NULL DEFAULT 'held', acquired_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
  PRIMARY KEY(mission_id,id)
);
CREATE INDEX IF NOT EXISTS claims_live ON claims(mission_id,state);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS work_id text;
CREATE TABLE IF NOT EXISTS work_items (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL,
  title text NOT NULL, resources jsonb NOT NULL, requirement_ids jsonb NOT NULL,
  requires jsonb NOT NULL DEFAULT '{}', revision integer NOT NULL DEFAULT 1,
  PRIMARY KEY(mission_id,id)
);
CREATE TABLE IF NOT EXISTS knowledge (
  mission_id text NOT NULL REFERENCES missions(id), id text NOT NULL, revision integer NOT NULL DEFAULT 1,
  kind text NOT NULL, title text NOT NULL, body text NOT NULL, agent_id text NOT NULL, run_id text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}', conditions jsonb NOT NULL DEFAULT '[]', unknowns jsonb NOT NULL DEFAULT '[]',
  freshness text NOT NULL DEFAULT 'current', readiness text NOT NULL DEFAULT 'warm', status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,id)
);
CREATE INDEX IF NOT EXISTS knowledge_search ON knowledge USING gin(to_tsvector('english',title || ' ' || body));
CREATE TABLE IF NOT EXISTS knowledge_history (
  mission_id text NOT NULL, id text NOT NULL, revision integer NOT NULL, snapshot jsonb NOT NULL,
  PRIMARY KEY(mission_id,id,revision)
);
CREATE TABLE IF NOT EXISTS knowledge_edges (
  mission_id text NOT NULL REFERENCES missions(id), from_id text NOT NULL, from_revision integer NOT NULL,
  to_id text NOT NULL, to_revision integer NOT NULL, kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,from_id,from_revision,to_id,to_revision,kind)
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id text PRIMARY KEY, mission_id text NOT NULL REFERENCES missions(id), agent_id text NOT NULL, run_id text NOT NULL,
  body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reviews (
  id text PRIMARY KEY, mission_id text NOT NULL REFERENCES missions(id), agent_id text NOT NULL, run_id text NOT NULL,
  kind text NOT NULL, target_id text, target_revision integer, roadmap_hash text NOT NULL,
  manifest_hash text NOT NULL, coverage_hash text, verdict text NOT NULL, reasoning text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkpoints_run ON checkpoints(mission_id,run_id,created_at);
CREATE INDEX IF NOT EXISTS reviews_scope ON reviews(mission_id,manifest_hash,kind,target_id,target_revision,agent_id,created_at);
CREATE TABLE IF NOT EXISTS verifications (
  id text PRIMARY KEY, mission_id text NOT NULL REFERENCES missions(id), manifest_hash text NOT NULL,
  results jsonb NOT NULL, passed boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS completion_proposals (
  mission_id text NOT NULL REFERENCES missions(id), operation_id text NOT NULL, run_id text NOT NULL,
  request jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', result jsonb, error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mission_id,operation_id)
);
INSERT INTO mesh_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
