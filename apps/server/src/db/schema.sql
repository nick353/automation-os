PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_provider TEXT NOT NULL DEFAULT 'legacy_operator_token',
  auth_subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'human',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(auth_provider, auth_subject)
);

CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_memberships (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'approver', 'viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, user_id)
);

CREATE INDEX IF NOT EXISTS company_memberships_user_idx ON company_memberships(user_id, status);
CREATE INDEX IF NOT EXISTS company_memberships_company_idx ON company_memberships(company_id, status);

CREATE TABLE IF NOT EXISTS company_audit_events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  before_json TEXT NOT NULL DEFAULT '{}',
  after_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS company_audit_events_company_idx ON company_audit_events(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  automation_id TEXT,
  automation_version_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  objective TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  execution_source TEXT NOT NULL DEFAULT 'legacy',
  quarantined INTEGER NOT NULL DEFAULT 0,
  readback_proof_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id);
CREATE INDEX IF NOT EXISTS idx_runs_automation ON runs(automation_id);
CREATE INDEX IF NOT EXISTS idx_runs_automation_version ON runs(automation_version_id);
CREATE INDEX IF NOT EXISTS idx_runs_worker_claim ON runs(execution_source, quarantined, status, created_at);

CREATE TABLE IF NOT EXISTS run_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  company_id TEXT,
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
  company_id TEXT,
  run_id TEXT,
  job_id TEXT,
  step_id TEXT,
  title TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  approval_group_id TEXT NOT NULL,
  action_kind TEXT,
  target_account_ref_id TEXT,
  payload_hash TEXT,
  policy_version TEXT,
  expires_at TEXT,
  decided_by_user_id TEXT,
  decision_revision INTEGER NOT NULL DEFAULT 1,
  consumed_at TEXT,
  consumed_by_attempt_id TEXT,
  resource_locks_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);

CREATE TABLE IF NOT EXISTS proofs (
  id TEXT PRIMARY KEY,
  company_id TEXT,
  run_id TEXT NOT NULL,
  step_id TEXT,
  artifact_id TEXT,
  attempt_id TEXT,
  fencing_token INTEGER,
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
  company_id TEXT,
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
  company_id TEXT,
  run_id TEXT NOT NULL,
  name TEXT NOT NULL,
  draft_markdown TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stored_secrets (
  id TEXT PRIMARY KEY,
  company_id TEXT,
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
  company_id TEXT,
  feedback_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  route TEXT NOT NULL,
  page_title TEXT NOT NULL,
  comment TEXT NOT NULL,
  artifact_uri TEXT NOT NULL,
  has_screenshot INTEGER NOT NULL DEFAULT 0,
  screenshot_artifact_id TEXT,
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
CREATE INDEX IF NOT EXISTS mvp_feedback_company_idx ON mvp_feedback(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback_artifacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feedback_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'screenshot',
  mime_type TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content_base64 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS feedback_artifacts_company_idx ON feedback_artifacts(company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mvp_automations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
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
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mvp_automations_project_idx ON mvp_automations(project_id);
CREATE INDEX IF NOT EXISTS mvp_automations_updated_at_idx ON mvp_automations(updated_at DESC);
CREATE INDEX IF NOT EXISTS mvp_automations_company_idx ON mvp_automations(company_id);
CREATE INDEX IF NOT EXISTS mvp_automations_current_version_idx ON mvp_automations(current_version_id);

CREATE TABLE IF NOT EXISTS mvp_automation_versions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1,
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
  updated_at TEXT NOT NULL,
  UNIQUE(automation_id, revision)
);

CREATE INDEX IF NOT EXISTS mvp_automation_versions_company_idx ON mvp_automation_versions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mvp_automation_versions_automation_idx ON mvp_automation_versions(automation_id, revision DESC);

CREATE TABLE IF NOT EXISTS mvp_automation_schedules (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  automation_id TEXT NOT NULL REFERENCES mvp_automations(id) ON DELETE CASCADE,
  automation_version_id TEXT REFERENCES mvp_automation_versions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  expression TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  revision INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  paused_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, automation_id)
);

CREATE INDEX IF NOT EXISTS mvp_automation_schedules_company_idx ON mvp_automation_schedules(company_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS mvp_automation_schedules_automation_idx ON mvp_automation_schedules(automation_id, revision DESC);
CREATE UNIQUE INDEX IF NOT EXISTS mvp_automation_schedules_single_idx ON mvp_automation_schedules(company_id, automation_id);

CREATE TABLE IF NOT EXISTS durable_schedule_occurrences (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  schedule_id TEXT NOT NULL REFERENCES mvp_automation_schedules(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  job_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, occurrence_key)
);

CREATE INDEX IF NOT EXISTS durable_schedule_occurrences_company_idx ON durable_schedule_occurrences(company_id, status, scheduled_for DESC);
CREATE INDEX IF NOT EXISTS durable_schedule_occurrences_schedule_idx ON durable_schedule_occurrences(schedule_id, scheduled_for DESC);

CREATE TABLE IF NOT EXISTS durable_concurrency_slots (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  concurrency_key TEXT NOT NULL,
  slot_limit INTEGER NOT NULL DEFAULT 1,
  active_count INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, concurrency_key)
);

CREATE INDEX IF NOT EXISTS durable_concurrency_slots_company_idx ON durable_concurrency_slots(company_id, concurrency_key, updated_at DESC);

CREATE TABLE IF NOT EXISTS durable_jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  automation_id TEXT REFERENCES mvp_automations(id) ON DELETE SET NULL,
  automation_version_id TEXT REFERENCES mvp_automation_versions(id) ON DELETE SET NULL,
  schedule_occurrence_id TEXT REFERENCES durable_schedule_occurrences(id) ON DELETE SET NULL,
  concurrency_key TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'dry_run',
  external_intent_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued',
  payload_json TEXT NOT NULL DEFAULT '{}',
  payload_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  heartbeat_at TEXT,
  provider_called INTEGER NOT NULL DEFAULT 0,
  reservation_id TEXT,
  reconciliation_started_at TEXT,
  reconciliation_owner TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS durable_jobs_company_idx ON durable_jobs(company_id, status, priority DESC, available_at ASC, created_at DESC);
CREATE INDEX IF NOT EXISTS durable_jobs_run_idx ON durable_jobs(run_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS durable_jobs_automation_idx ON durable_jobs(automation_id, automation_version_id, status, available_at ASC);
CREATE INDEX IF NOT EXISTS durable_jobs_schedule_occurrence_idx ON durable_jobs(schedule_occurrence_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS durable_jobs_concurrency_idx ON durable_jobs(company_id, concurrency_key, status, available_at ASC, created_at DESC);

CREATE TABLE IF NOT EXISTS durable_job_attempts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES durable_jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  service_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running',
  provider_called INTEGER NOT NULL DEFAULT 0,
  provider_called_at TEXT,
  reservation_id TEXT,
  reconciliation_started_at TEXT,
  reconciliation_owner TEXT,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, attempt_no)
);

CREATE INDEX IF NOT EXISTS durable_job_attempts_company_idx ON durable_job_attempts(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS durable_job_attempts_job_idx ON durable_job_attempts(job_id, attempt_no DESC);

CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id TEXT REFERENCES run_steps(id) ON DELETE SET NULL,
  attempt_id TEXT REFERENCES durable_job_attempts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_text TEXT,
  status TEXT NOT NULL DEFAULT 'available',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS run_artifacts_company_idx ON run_artifacts(company_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS run_artifacts_run_idx ON run_artifacts(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS run_artifacts_step_idx ON run_artifacts(step_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mvp_idempotency_keys (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS mvp_idempotency_keys_company_idx ON mvp_idempotency_keys(company_id, scope, status, created_at DESC);

CREATE TABLE IF NOT EXISTS company_memory_entries (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  memory_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, memory_key)
);

CREATE INDEX IF NOT EXISTS company_memory_entries_company_idx ON company_memory_entries(company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS company_connection_account_refs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  oauth_state TEXT NOT NULL DEFAULT 'not_configured',
  verification_status TEXT NOT NULL DEFAULT 'unverified',
  last_verified_at TEXT,
  reconnect_requested_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, platform, account_ref)
);

CREATE INDEX IF NOT EXISTS company_connection_account_refs_company_idx ON company_connection_account_refs(company_id, status, updated_at DESC);

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
  company_id TEXT,
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
  company_id TEXT,
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

-- Named chat sessions are separate from the legacy create_sessions(id='default')
-- compatibility record.  Ownership is intentionally actor + company scoped.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  codex_thread_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(company_id, actor_user_id, name)
);

CREATE INDEX IF NOT EXISTS chat_sessions_scope_idx
  ON chat_sessions(company_id, actor_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_thread_idx
  ON chat_sessions(codex_thread_id);

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
  metadata_json TEXT NOT NULL DEFAULT '{}',
  lease_owner TEXT,
  lease_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_lanes_run ON lanes(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_company ON runs(company_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_company_status ON approvals(company_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_bound_action ON approvals(company_id, job_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_proofs_run ON proofs(run_id);
CREATE INDEX IF NOT EXISTS idx_proofs_company_run ON proofs(company_id, run_id);
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
CREATE INDEX IF NOT EXISTS idx_registered_workflows_company ON registered_workflows(company_id);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_status ON registered_workflows(status);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_runner_status ON registered_workflows(runner_status);
CREATE INDEX IF NOT EXISTS idx_registered_workflows_updated ON registered_workflows(updated_at);
CREATE INDEX IF NOT EXISTS idx_research_plans_company ON research_plans(company_id);
CREATE INDEX IF NOT EXISTS idx_research_plans_updated ON research_plans(updated_at);
CREATE INDEX IF NOT EXISTS idx_research_plans_status ON research_plans(status);
CREATE INDEX IF NOT EXISTS idx_skills_company ON skills(company_id);
CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_status ON create_planner_jobs(status);
CREATE INDEX IF NOT EXISTS idx_create_planner_jobs_updated ON create_planner_jobs(updated_at);

CREATE TABLE IF NOT EXISTS service_readiness_effect_ledger (
  effect_key TEXT PRIMARY KEY CHECK (length(effect_key) = 64),
  company_id TEXT NOT NULL DEFAULT 'legacy',
  reservation_id TEXT NOT NULL DEFAULT '',
  reservation_token_hash TEXT,
  capability_id TEXT NOT NULL DEFAULT '',
  approval_id TEXT NOT NULL DEFAULT '',
  approval_revision INTEGER NOT NULL DEFAULT 0,
  root_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  provider TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('internal_idempotent', 'external_non_idempotent')),
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'blocked', 'reconciliation_required', 'cancelled')),
  external_action_executed INTEGER NOT NULL CHECK (external_action_executed IN (0, 1)),
  provider_receipt_hash TEXT,
  cleanup_receipt_hash TEXT,
  exact_blocker TEXT,
  safe_resume_step TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT
);

CREATE INDEX IF NOT EXISTS service_readiness_effect_ledger_binding_idx
  ON service_readiness_effect_ledger(company_id, root_id, workflow_id, run_id, stage_id, attempt_id, fencing_token);
CREATE INDEX IF NOT EXISTS service_readiness_effect_ledger_status_idx
  ON service_readiness_effect_ledger(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS service_readiness_effect_ledger_company_effect_idx
  ON service_readiness_effect_ledger(company_id, effect_key);
