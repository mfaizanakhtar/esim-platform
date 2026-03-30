import { useState, useRef, useCallback } from 'react';
import type { AiMappingDraft } from '@/lib/types';
import { buildSseUrl } from '@/lib/api';

type StreamStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

type StreamProgress = {
  batch: number;
  totalBatches: number;
  found: number;
};

type StartParams = {
  provider?: string;
  unmappedOnly?: boolean;
};

export function useAiMapStream() {
  const [status, setStatus] = useState<StreamStatus>('idle');
  const [progress, setProgress] = useState<StreamProgress | null>(null);
  const [drafts, setDrafts] = useState<AiMappingDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  const cancel = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setStatus('cancelled');
    setProgress(null);
  }, []);

  const start = useCallback((params: StartParams) => {
    // Clean up any existing stream
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }

    setStatus('running');
    setProgress(null);
    setDrafts([]);
    setError(null);

    const url = buildSseUrl('/sku-mappings/ai-map/stream', {
      ...(params.provider ? { provider: params.provider } : {}),
      unmappedOnly: params.unmappedOnly === false ? 'false' : 'true',
    });

    const es = new EventSource(url);
    sourceRef.current = es;

    es.addEventListener('progress', (e: MessageEvent) => {
      try {
        const evt = JSON.parse(e.data) as {
          batch: number;
          totalBatches: number;
          foundSoFar: number;
          partialDrafts: AiMappingDraft[];
        };
        setProgress({ batch: evt.batch, totalBatches: evt.totalBatches, found: evt.foundSoFar });
        setDrafts((prev) => [...prev, ...evt.partialDrafts]);
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener('done', () => {
      es.close();
      sourceRef.current = null;
      setStatus('done');
    });

    es.addEventListener('error', (e: MessageEvent) => {
      es.close();
      sourceRef.current = null;
      let msg = 'Stream failed';
      try {
        const data = JSON.parse(e.data) as { message?: string };
        if (data.message) msg = data.message;
      } catch {
        // use default message
      }
      setError(msg);
      setStatus('error');
    });

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      es.close();
      sourceRef.current = null;
      setError('Connection lost');
      setStatus('error');
    };
  }, []);

  return { start, cancel, status, progress, drafts, error };
}
