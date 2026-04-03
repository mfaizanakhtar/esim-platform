CREATE TABLE "AiMapJob" (
  "id"               TEXT PRIMARY KEY,
  "status"           TEXT NOT NULL DEFAULT 'running',
  "provider"         TEXT,
  "unmappedOnly"     BOOLEAN NOT NULL DEFAULT true,
  "totalBatches"     INT,
  "completedBatches" INT NOT NULL DEFAULT 0,
  "foundSoFar"       INT NOT NULL DEFAULT 0,
  "draftsJson"       JSONB NOT NULL DEFAULT '[]',
  "warning"          TEXT,
  "error"            TEXT,
  "createdAt"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "completedAt"      TIMESTAMPTZ
);
