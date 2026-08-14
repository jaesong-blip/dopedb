PRAGMA foreign_keys = ON;

CREATE TABLE product_analytics_event_v1 (
  event_id TEXT PRIMARY KEY NOT NULL CHECK (length(event_id) = 64),
  name TEXT NOT NULL CHECK (name IN (
    'desktop_installation_ready',
    'workspace_authentication_completed',
    'workspace_scope_ready',
    'knowledge_environment_created',
    'connection_verification_completed',
    'environment_connection_bound',
    'query_execution_completed',
    'knowledge_source_sync_completed',
    'agent_session_initialization_completed',
    'agent_turn_completed',
    'analysis_article_proposal_completed',
    'analysis_article_run_completed',
    'analysis_article_state_transitioned',
    'workspace_membership_ready',
    'shared_connection_access_ready'
  )),
  occurred_at TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  installation_id TEXT NOT NULL CHECK (length(installation_id) = 36),
  session_id TEXT NOT NULL CHECK (length(session_id) = 36),
  app_version TEXT NOT NULL CHECK (length(app_version) <= 128),
  platform TEXT NOT NULL CHECK (platform IN ('macos', 'windows', 'linux', 'unknown')),
  locale TEXT NOT NULL CHECK (locale IN ('ko', 'en')),
  actor_key TEXT CHECK (actor_key IS NULL OR length(actor_key) = 64),
  workspace_key TEXT CHECK (workspace_key IS NULL OR length(workspace_key) = 64),
  workspace_kind TEXT CHECK (workspace_kind IS NULL OR workspace_kind IN ('personal', 'team')),
  properties_json TEXT NOT NULL CHECK (json_valid(properties_json))
) STRICT;

CREATE INDEX product_analytics_event_received_idx
  ON product_analytics_event_v1 (received_at_ms, event_id);
CREATE INDEX product_analytics_event_installation_idx
  ON product_analytics_event_v1 (installation_id, occurred_at_ms, event_id);
CREATE INDEX product_analytics_event_workspace_idx
  ON product_analytics_event_v1 (workspace_key, occurred_at_ms, event_id)
  WHERE workspace_key IS NOT NULL;
CREATE INDEX product_analytics_event_name_idx
  ON product_analytics_event_v1 (name, occurred_at_ms, event_id);

CREATE TABLE product_analytics_daily_v1 (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,
  platform TEXT NOT NULL,
  locale TEXT NOT NULL,
  outcome TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  PRIMARY KEY (day, name, workspace_kind, platform, locale, outcome)
) WITHOUT ROWID, STRICT;
