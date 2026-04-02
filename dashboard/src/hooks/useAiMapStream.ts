import { useState, useRef, useCallback, useEffect } from 'react';
import type { AiMappingDraft } from '@/lib/types';
import { buildSseUrl, getApiKey } from '@/lib/api';

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
  const abortRef = useRef<AbortController | null>(null);

  // Close the stream when the component unmounts
  useEffect(() => {
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, []);

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStatus('cancelled');
    setProgress(null);
  }, []);

  const start = useCallback(async (params: StartParams) => {
    // Cancel any in-flight stream before starting a new one
    if (abortRef.current) {
      abortRef.current.abort();
    }

    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('running');
    setProgress(null);
    setDrafts([]);
    setError(null);

    const url = buildSseUrl('/sku-mappings/ai-map/stream', {
      ...(params.provider ? { provider: params.provider } : {}),
      unmappedOnly: params.unmappedOnly === false ? 'false' : 'true',
    });

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'x-admin-key': getApiKey() ?? '',
          Accept: 'text/event-stream',
        },
      });

      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let explicitDone = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // SSE events are separated by blank lines (\n\n)
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          let eventType = 'message';
          let data = '';

          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventType = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
          }

          if (eventType === 'progress') {
            try {
              const evt = JSON.parse(data) as {
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
          } else if (eventType === 'done') {
            explicitDone = true;
            setStatus('done');
            return;
          } else if (eventType === 'error') {
            explicitDone = true;
            let msg = 'Stream failed';
            try {
              const d = JSON.parse(data) as { message?: string };
              if (d.message) msg = d.message;
            } catch {
              // use default message
            }
            setError(msg);
            setStatus('error');
            return;
          }
        }
      }

      // Stream closed without an explicit done/error event — treat as complete
      if (!explicitDone) setStatus('done');
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return; // cancelled
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('error');
    }
  }, []);

  return { start, cancel, status, progress, drafts, error };
}
