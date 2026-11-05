export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Embedded, versioned schema (docs/003 §2). Times are ISO-8601 UTC strings. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-control-plane-schema',
    sql: `
CREATE TABLE demands (
  id TEXT PRIMARY KEY,
  no TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  requester TEXT NOT NULL,
  priority TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  workspace_binding TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_demands_status_created ON demands (status, created_at);

CREATE TABLE stage_runs (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  executor_kind TEXT NOT NULL,
  gate_key TEXT,
  input_refs TEXT NOT NULL,
  output_artifact_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (demand_id, stage_key)
);
CREATE INDEX idx_stage_runs_status ON stage_runs (status, executor_kind);
CREATE INDEX idx_stage_runs_demand ON stage_runs (demand_id);

CREATE TABLE stage_attempts (
  stage_run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  model TEXT,
  prompt_version TEXT,
  input_refs TEXT NOT NULL,
  schema_ok INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (stage_run_id, attempt)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL,
  stage_run_id TEXT,
  title TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  required_roles TEXT NOT NULL,
  workspace_binding TEXT,
  priority TEXT NOT NULL,
  due_at TEXT,
  state TEXT NOT NULL,
  last_holder_user_ids TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_state_created ON tasks (state, created_at);
CREATE INDEX idx_tasks_demand ON tasks (demand_id);

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  executor_id TEXT NOT NULL,
  user_id TEXT,
  state TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_assignments_state_task ON assignments (state, task_id);
CREATE INDEX idx_assignments_executor ON assignments (executor_id, state);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  stage_key TEXT,
  stage_run_id TEXT,
  state TEXT NOT NULL,
  current_version INTEGER NOT NULL,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_artifacts_demand_kind ON artifacts (demand_id, kind);

CREATE TABLE artifact_versions (
  artifact_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_ref TEXT NOT NULL,
  content_type TEXT NOT NULL,
  checksum TEXT NOT NULL,
  summary TEXT,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  stale INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, version)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  gate_key TEXT NOT NULL,
  state TEXT NOT NULL,
  required_role TEXT NOT NULL,
  decision TEXT,
  decided_by TEXT,
  decided_at TEXT,
  comment TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE executors (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user TEXT NOT NULL,
  machine_id_hash TEXT,
  capabilities TEXT NOT NULL,
  roles TEXT NOT NULL,
  workspaces TEXT NOT NULL,
  active_workspace_key TEXT,
  presence TEXT NOT NULL,
  accepting INTEGER NOT NULL,
  max_concurrent INTEGER NOT NULL,
  protocol_version TEXT NOT NULL,
  cli_version TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_executors_presence ON executors (presence);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  data TEXT NOT NULL,
  demand_id TEXT
);
CREATE INDEX idx_events_demand ON events (demand_id, seq);

CREATE TABLE idempotency (
  idempotency_key TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  event_seq INTEGER NOT NULL,
  target TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'stage-run-order-index',
    sql: `
ALTER TABLE stage_runs ADD COLUMN stage_index INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_stage_runs_demand_order ON stage_runs (demand_id, stage_index);
`,
  },
  // --- H1: approval gates + notifications (docs/003 §2.5, H1 task book §1.2) ---
  {
    version: 3,
    name: 'approval-runtime-and-notifications',
    sql: `
ALTER TABLE approvals ADD COLUMN artifact_id TEXT;
ALTER TABLE approvals ADD COLUMN artifact_version INTEGER;
CREATE INDEX idx_approvals_state_expires ON approvals (state, expires_at);
CREATE INDEX idx_approvals_demand ON approvals (demand_id, created_at);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  demand_id TEXT NOT NULL,
  stage_run_id TEXT,
  approval_id TEXT,
  kind TEXT NOT NULL,
  required_role TEXT,
  title TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX idx_notifications_unread ON notifications (read_at, created_at);
CREATE INDEX idx_notifications_demand ON notifications (demand_id, created_at);
`,
  },
];
