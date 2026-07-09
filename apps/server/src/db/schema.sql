PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  lane_id TEXT,
  started_at TEXT,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS lanes (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  role TEXT NOT NULL,
  cdp_port INTEGER NOT NULL,
  profile_dir TEXT NOT NULL,
  workdir TEXT NOT NULL,
  browser_use_session TEXT,
  browser_use_cdp_url TEXT,
  browser_use_profile TEXT,
  profile_strategy TEXT NOT NULL DEFAULT 'cdp_profile_lane',
  lane_visibility TEXT NOT NULL DEFAULT 'visible',
  status TEXT NOT NULL,
  current_task TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'good',
  resource_locks_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  title TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  approval_group_id TEXT NOT NULL,
  resource_locks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  proof_type TEXT NOT NULL,
  label TEXT NOT NULL,
  uri TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS child_runs (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  prompt_uri TEXT NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  exit_status INTEGER,
  signal TEXT,
  result_uri TEXT,
  summary TEXT,
  blocker TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS worker_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  lane_id TEXT,
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS advisor_events (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  trigger_context TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS codex_assets (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  modified_at TEXT,
  imported_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  draft_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stored_secrets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  masked_value TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS system_checks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_url TEXT,
  summary TEXT NOT NULL,
  artifact_uri TEXT,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bridge_actions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  target TEXT,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS bridge_executions (
  id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL,
  approval_id TEXT,
  status TEXT NOT NULL,
  executor_status TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS mvp_feedback (
  id TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  route TEXT NOT NULL,
  page_title TEXT NOT NULL,
  comment TEXT NOT NULL,
  artifact_uri TEXT NOT NULL,
  has_screenshot INTEGER NOT NULL DEFAULT 0,
  viewport_json TEXT NOT NULL DEFAULT '{}',
  workflow_context_json TEXT NOT NULL DEFAULT '{}',
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  fix_target TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mvp_feedback_status_idx ON mvp_feedback(status);
CREATE INDEX IF NOT EXISTS mvp_feedback_route_idx ON mvp_feedback(route);
CREATE INDEX IF NOT EXISTS mvp_feedback_created_at_idx ON mvp_feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS mvp_automations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  automation_type TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  goal TEXT NOT NULL,
  schedule TEXT NOT NULL,
  cadence TEXT NOT NULL,
  lane TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_policy TEXT NOT NULL,
  worker_command_kind TEXT NOT NULL,
  create_approval INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',
  builder_spec_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mvp_automations_project_idx ON mvp_automations(project_id);
CREATE INDEX IF NOT EXISTS mvp_automations_updated_at_idx ON mvp_automations(updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_notes (
  id TEXT PRIMARY KEY,
  note_type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  source_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS registered_workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  runner_status TEXT NOT NULL,
  runner_kind TEXT NOT NULL,
  project_root TEXT NOT NULL,
  start_command_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  source_refs_json TEXT NOT NULL DEFAULT '[]',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_plans (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  command TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  visible_flow_json TEXT NOT NULL DEFAULT '[]',
  source_of_truth_json TEXT NOT NULL DEFAULT '[]',
  proof_boundary_json TEXT NOT NULL DEFAULT '[]',
  approval_boundary_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  demo_check_id TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS create_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  draft_json TEXT NOT NULL DEFAULT '{}',
  research_sources_json TEXT NOT NULL DEFAULT '{}',
  command TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS create_planner_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  messages_json TEXT NOT NULL DEFAULT '[]',
  current_draft TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  exact_blocker TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_lanes_run ON lanes(run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_proofs_run ON proofs(run_id);
CREATE INDEX IF NOT EXISTS idx_child_runs_parent ON child_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_child_runs_step ON child_runs(step_id);
CREATE INDEX IF NOT EXISTS idx_worker_events_run ON worker_events(run_id);
CREATE INDEX IF NOT EXISTS idx_assets_source ON codex_assets(source_type);
CREATE INDEX IF NOT EXISTS idx_stored_secrets_kind ON stored_secrets(kind);
CREATE INDEX IF NOT EXISTS idx_system_checks_created ON system_checks(created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_actions_created ON bridge_actions(created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_executions_created ON bridge_executions(created_at);
CREATE INDEX IF NOT EXISTS idx_bridge_executions_approval ON bridge_executions(approval_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_notes_updated ON knowledge_notes(updated_at);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_status ON registered_workflows(status);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_runner_status ON registered_workflows(runner_status);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_updated ON registered_workflows(updated_at);
CREATE INDEX IF NOT EXISTS idx_research_plans_updated ON research_plans(updated_at);
CREATE INDEX IF NOT EXISTS idx_research_plans_status ON research_plans(status);
CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_status ON create_planner_jobs(status);
CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_updated ON create_planner_jobs(updated_at);
