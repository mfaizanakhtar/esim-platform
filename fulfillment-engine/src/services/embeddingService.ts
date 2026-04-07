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
  // OpenAI limits embedding batches to 2048 inputs — chunk if needed
  const CHUNK_SIZE = 2048;
  if (texts.length <= CHUNK_SIZE) {
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: texts });
    return res.data.map((d) => d.embedding);
  }
  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += CHUNK_SIZE) {
    const chunk = texts.slice(i, i + CHUNK_SIZE);
    const res = await openai.embeddings.create({ model: 'text-embedding-3-small', input: chunk });
    results.push(...res.data.map((d) => d.embedding));
  }
  return results;
}

export async function storeEmbedding(catalogId: string, embedding: number[]): Promise<void> {
  const vectorStr = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`UPDATE "ProviderSkuCatalog" SET embedding = ${vectorStr}::vector WHERE id = ${catalogId}`;
}

export interface ParsedCatalogAttributes {
  regionCodes: string[];
  dataMb: number;
  validityDays: number;
}

/**
 * Use AI to parse a catalog entry into structured { regionCodes, dataMb, validityDays }.
 * Returns null on any error — non-blocking, caller should handle gracefully.
 */
export async function parseCatalogEntry(
  entry: {
    productName: string;
    region: string | null;
    countryCodes: unknown;
    dataAmount: string | null;
    validity: string | null;
  },
  openai: OpenAI,
): Promise<ParsedCatalogAttributes | null> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Parse this eSIM product into { "regionCodes": string[], "dataMb": number, "validityDays": number }. dataMb: 1GB=1024. regionCodes should be ISO 3166-1 alpha-2 country codes or short region codes like EU, US, APAC, GLOBAL. Return only JSON.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            productName: entry.productName,
            region: entry.region,
            countryCodes: entry.countryCodes,
            dataAmount: entry.dataAmount,
            validity: entry.validity,
          }),
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ParsedCatalogAttributes>;
    if (
      !Array.isArray(parsed.regionCodes) ||
      typeof parsed.dataMb !== 'number' ||
      typeof parsed.validityDays !== 'number'
    ) {
      return null;
    }
    return {
      regionCodes: parsed.regionCodes as string[],
      dataMb: parsed.dataMb,
      validityDays: parsed.validityDays,
    };
  } catch (err) {
    logger.warn({ err, productName: entry.productName }, 'parseCatalogEntry failed');
    return null;
  }
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
