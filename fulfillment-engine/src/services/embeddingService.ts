import prisma from '~/db/prisma';
import OpenAI from 'openai';
import { logger } from '~/utils/logger';

export function buildCatalogText(entry: {
  productName: string;
  region: string | null;
  dataAmount: string | null;
  validity: string | null;
}): string {
  return [entry.productName, entry.region, entry.dataAmount, entry.validity]
    .filter(Boolean)
    .join(' | ');
}

export async function embedText(text: string, openai: OpenAI): Promise<number[]> {
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding;
}

export async function embedBatch(texts: string[], openai: OpenAI): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}

export async function storeEmbedding(catalogId: string, embedding: number[]): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`UPDATE "ProviderSkuCatalog" SET embedding = ${vectorStr}::vector WHERE id = ${catalogId}`;
}

type CandidateRow = {
  id: string;
  provider: string;
  productCode: string;
  productName: string;
  region: string | null;
  dataAmount: string | null;
  validity: string | null;
  netPrice: unknown;
};

export async function findTopCandidates(
  queryEmbedding: number[],
  provider?: string,
  k = 20,
): Promise<CandidateRow[]> {
  const vectorStr = `[${queryEmbedding.join(',')}]`;
  if (provider) {
    return prisma.$queryRaw<CandidateRow[]>`
      SELECT id, provider, "productCode", "productName", region, "dataAmount", validity, "netPrice"
      FROM "ProviderSkuCatalog"
      WHERE "isActive" = true
        AND embedding IS NOT NULL
        AND provider = ${provider}
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${k}
    `;
  }
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT id, provider, "productCode", "productName", region, "dataAmount", validity, "netPrice"
    FROM "ProviderSkuCatalog"
    WHERE "isActive" = true
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vectorStr}::vector
    LIMIT ${k}
  `;
}

export async function isVectorAvailable(): Promise<boolean> {
  try {
    const result = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count FROM pg_extension WHERE extname = 'vector'
    `;
    return Number(result[0]?.count ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function backfillMissingEmbeddings(
  openai: OpenAI,
  provider?: string,
): Promise<number> {
  type NullEmbeddingRow = {
    id: string;
    productName: string;
    region: string | null;
    dataAmount: string | null;
    validity: string | null;
  };

  // Use a session-level advisory lock (id 0xEB4C = "embed backfill") so that
  // concurrent calls don't double-embed the same rows or double-bill OpenAI.
  const LOCK_ID = 0xeb4c;
  const [lockResult] = await prisma.$queryRaw<[{ acquired: boolean }]>`
    SELECT pg_try_advisory_lock(${LOCK_ID}::bigint) AS acquired
  `;
  if (!lockResult.acquired) {
    logger.warn('Backfill advisory lock not acquired — another backfill is in progress');
    return 0;
  }

  const BATCH_SIZE = 500;
  let total = 0;
  let hasMore = true;

  try {
    while (hasMore) {
      let rows: NullEmbeddingRow[];
      if (provider) {
        rows = await prisma.$queryRaw<NullEmbeddingRow[]>`
          SELECT id, "productName", region, "dataAmount", validity
          FROM "ProviderSkuCatalog"
          WHERE embedding IS NULL AND provider = ${provider}
          LIMIT ${BATCH_SIZE}
        `;
      } else {
        rows = await prisma.$queryRaw<NullEmbeddingRow[]>`
          SELECT id, "productName", region, "dataAmount", validity
          FROM "ProviderSkuCatalog"
          WHERE embedding IS NULL
          LIMIT ${BATCH_SIZE}
        `;
      }

      if (rows.length === 0) {
        hasMore = false;
        break;
      }

      const texts = rows.map(buildCatalogText);
      const vectors = await embedBatch(texts, openai);
      await Promise.all(rows.map((r, i) => storeEmbedding(r.id, vectors[i])));
      total += rows.length;
      logger.info({ count: rows.length, total }, 'Backfilled catalog embeddings batch');
    }
  } finally {
    await prisma.$executeRaw`SELECT pg_advisory_unlock(${LOCK_ID}::bigint)`;
  }

  return total;
}
