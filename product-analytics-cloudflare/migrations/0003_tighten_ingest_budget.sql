CREATE TABLE product_analytics_ingest_budget_v1_next (
  minute_bucket INTEGER PRIMARY KEY NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count BETWEEN 1 AND 16)
) WITHOUT ROWID, STRICT;

INSERT INTO product_analytics_ingest_budget_v1_next (minute_bucket, event_count)
SELECT minute_bucket, event_count
FROM product_analytics_ingest_budget_v1
WHERE event_count BETWEEN 1 AND 16;

DROP TABLE product_analytics_ingest_budget_v1;
ALTER TABLE product_analytics_ingest_budget_v1_next
  RENAME TO product_analytics_ingest_budget_v1;
