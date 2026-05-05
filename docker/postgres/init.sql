CREATE TABLE IF NOT EXISTS catalog_routing (
  catalog_id   TEXT        PRIMARY KEY,
  node_url     TEXT        NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
