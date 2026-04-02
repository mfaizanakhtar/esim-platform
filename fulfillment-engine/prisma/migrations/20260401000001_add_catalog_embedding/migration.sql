CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "ProviderSkuCatalog"
  ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

-- HNSW index for fast approximate cosine similarity (no training required)
CREATE INDEX IF NOT EXISTS "ProviderSkuCatalog_embedding_hnsw_idx"
  ON "ProviderSkuCatalog"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
