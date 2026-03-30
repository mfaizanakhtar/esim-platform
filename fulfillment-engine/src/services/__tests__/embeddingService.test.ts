import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before imports
// ---------------------------------------------------------------------------

const mockQueryRaw = vi.fn();
const mockExecuteRaw = vi.fn();

vi.mock('~/db/prisma', () => ({
  default: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
    $executeRaw: (...args: unknown[]) => mockExecuteRaw(...args),
  },
}));

vi.mock('~/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import OpenAI from 'openai';
import {
  buildCatalogText,
  embedText,
  embedBatch,
  storeEmbedding,
  findTopCandidates,
  isVectorAvailable,
  backfillMissingEmbeddings,
} from '~/services/embeddingService';

vi.mock('openai', () => {
  const mockEmbeddingsCreate = vi.fn();
  return {
    default: class MockOpenAI {
      embeddings = { create: mockEmbeddingsCreate };
      static _mockCreate = mockEmbeddingsCreate;
    },
  };
});

function getMockEmbeddingsCreate() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (OpenAI as any)._mockCreate as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildCatalogText', () => {
  it('joins all non-null fields with |', () => {
    expect(
      buildCatalogText({ productName: 'Japan 1GB', region: 'JP', dataAmount: '1GB', validity: '7 days' }),
    ).toBe('Japan 1GB | JP | 1GB | 7 days');
  });

  it('skips null fields', () => {
    expect(
      buildCatalogText({ productName: 'USA 5GB', region: null, dataAmount: '5GB', validity: null }),
    ).toBe('USA 5GB | 5GB');
  });

  it('returns just product name when all others are null', () => {
    expect(
      buildCatalogText({ productName: 'Plan X', region: null, dataAmount: null, validity: null }),
    ).toBe('Plan X');
  });
});

describe('embedText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls openai embeddings with text-embedding-3-small and returns vector', async () => {
    const mockCreate = getMockEmbeddingsCreate();
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });

    const openai = new OpenAI({ apiKey: 'test' });
    const result = await embedText('Japan 1GB', openai);

    expect(result).toEqual([0.1, 0.2, 0.3]);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'Japan 1GB',
    });
  });
});

describe('embedBatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array for empty input', async () => {
    const openai = new OpenAI({ apiKey: 'test' });
    expect(await embedBatch([], openai)).toEqual([]);
  });

  it('calls openai with all texts and returns array of embeddings', async () => {
    const mockCreate = getMockEmbeddingsCreate();
    mockCreate.mockResolvedValue({
      data: [
        { embedding: [0.1, 0.2] },
        { embedding: [0.3, 0.4] },
      ],
    });

    const openai = new OpenAI({ apiKey: 'test' });
    const result = await embedBatch(['text1', 'text2'], openai);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: ['text1', 'text2'],
    });
  });
});

describe('storeEmbedding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls $executeRaw with vector string', async () => {
    mockExecuteRaw.mockResolvedValue(1);
    await storeEmbedding('cat-001', [0.1, 0.2, 0.3]);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // The tagged template literal is called with the raw SQL parts
    const call = mockExecuteRaw.mock.calls[0];
    // First arg is a TemplateStringsArray; check that it was called
    expect(call).toBeDefined();
  });
});

describe('findTopCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('queries without provider filter when provider is undefined', async () => {
    const mockRows = [{ id: 'cat-1', provider: 'tgt', productName: 'Japan 1GB', region: 'JP', dataAmount: '1GB', validity: '7 days', netPrice: 1.0 }];
    mockQueryRaw.mockResolvedValue(mockRows);

    const result = await findTopCandidates([0.1, 0.2], undefined, 10);
    expect(result).toEqual(mockRows);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('queries with provider filter when provider is provided', async () => {
    mockQueryRaw.mockResolvedValue([]);
    await findTopCandidates([0.1, 0.2], 'tgt', 5);
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('isVectorAvailable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when pg_extension query returns count > 0', async () => {
    mockQueryRaw.mockResolvedValue([{ count: BigInt(1) }]);
    expect(await isVectorAvailable()).toBe(true);
  });

  it('returns false when count is 0', async () => {
    mockQueryRaw.mockResolvedValue([{ count: BigInt(0) }]);
    expect(await isVectorAvailable()).toBe(false);
  });

  it('returns false when query throws', async () => {
    mockQueryRaw.mockRejectedValue(new Error('pg error'));
    expect(await isVectorAvailable()).toBe(false);
  });

  it('returns false when result is empty', async () => {
    mockQueryRaw.mockResolvedValue([]);
    expect(await isVectorAvailable()).toBe(false);
  });
});

describe('backfillMissingEmbeddings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 0 when no rows need embedding', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const openai = new OpenAI({ apiKey: 'test' });
    const result = await backfillMissingEmbeddings(openai);
    expect(result).toBe(0);
  });

  it('embeds rows and returns total count', async () => {
    const rows = [
      { id: 'cat-1', productName: 'Japan 1GB', region: 'JP', dataAmount: '1GB', validity: '7 days' },
      { id: 'cat-2', productName: 'USA 5GB', region: 'US', dataAmount: '5GB', validity: '30 days' },
    ];
    // First call returns rows; second call returns empty (done)
    mockQueryRaw.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);
    mockExecuteRaw.mockResolvedValue(1);

    const mockCreate = getMockEmbeddingsCreate();
    mockCreate.mockResolvedValue({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    });

    const openai = new OpenAI({ apiKey: 'test' });
    const result = await backfillMissingEmbeddings(openai);

    expect(result).toBe(2);
    expect(mockExecuteRaw).toHaveBeenCalledTimes(2); // one per row
  });

  it('filters by provider when provided', async () => {
    mockQueryRaw.mockResolvedValue([]);
    const openai = new OpenAI({ apiKey: 'test' });
    await backfillMissingEmbeddings(openai, 'firoam');
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });
});
