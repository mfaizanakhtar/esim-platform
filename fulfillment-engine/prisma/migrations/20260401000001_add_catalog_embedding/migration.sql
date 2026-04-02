-- Create pgvector extension if available; silently skip if not installed on this PostgreSQL instance.
-- The application's isVectorAvailable() check handles the missing-extension case gracefully.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector extension not available: %. Vector embedding features will be disabled.', SQLERRM;
END $$;

-- Only add the column and index when the extension loaded successfully
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    ALTER TABLE "ProviderSkuCatalog"
      ADD COLUMN IF NOT EXISTS "embedding" vector(1536);

    CREATE INDEX IF NOT EXISTS "ProviderSkuCatalog_embedding_hnsw_idx"
      ON "ProviderSkuCatalog"
      USING hnsw ("embedding" vector_cosine_ops)
      WITH (m = 16, ef_construction = 64);
  END IF;
END $$;
