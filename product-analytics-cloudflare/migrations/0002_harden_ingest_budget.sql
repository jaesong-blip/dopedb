DROP INDEX IF EXISTS product_analytics_event_received_idx;
DROP INDEX IF EXISTS product_analytics_event_installation_idx;
DROP INDEX IF EXISTS product_analytics_event_workspace_idx;
DROP INDEX IF EXISTS product_analytics_event_name_idx;

CREATE TABLE product_analytics_ingest_budget_v1 (
  minute_bucket INTEGER PRIMARY KEY NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 20)
) WITHOUT ROWID, STRICT;
