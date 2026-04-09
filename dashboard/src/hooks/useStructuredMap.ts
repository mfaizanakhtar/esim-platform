import { useState, useRef, useCallback, useEffect } from 'react';
import type { AiMappingDraft, UnmatchedSku } from '@/lib/types';
import { apiClient, buildJobSseUrl, getApiKey } from '@/lib/api';

type JobStatus = 'idle' | 'starting' | 'running' | 'done' | 'error';

type JobProgress = {
  batch: number;
  totalBatches: number;
  found: number;
};

type StartParams = {
  provider?: string;
  unmappedOnly?: boolean;
  relaxOptions?: { relaxValidity?: boolean; relaxData?: boolean; relaxRegion?: boolean };
};

function handle401(): never {
  try {
    sessionStorage.removeItem('esim-admin-api-key');
  } catch {
    // ignore
  }
  window.location.href = '/login';
  throw new Error('Unauthorized');
}

export function useStructuredMap() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus>('idle');
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [drafts, setDrafts] = useState<AiMappingDraft[]>([]);
  const [unmatchedSkus, setUnmatchedSkus] = useState<UnmatchedSku[]>([]);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const closeStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  useEffect(() => closeStream, [closeStream]);

  const cancel = useCallback(() => {
    closeStream();
    setStatus('idle');
    setProgress(null);
  }, [closeStream]);

  const reset = useCallback(() => {
    closeStream();
    setJobId(null);
    setStatus('idle');
    setProgress(null);
    setDrafts([]);
    setUnmatchedSkus([]);
    setError(null);
  }, [closeStream]);

  const connectToStream = useCallback(
    async (id: string) => {
      closeStream();

      const controller = new AbortController();
      abortRef.current = controller;

      setJobId(id);
      setStatus('running');
      setProgress(null);
      setDrafts([]);
      setUnmatchedSkus([]);
      setError(null);

      const url = buildJobSseUrl(id);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'x-admin-key': getApiKey() ?? '',
            Accept: 'text/event-stream',
          },
        });

        if (response.status === 401) {
          handle401();
        }

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let explicitEnd = false;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
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
                };
                setProgress({
                  batch: evt.batch,
                  totalBatches: evt.totalBatches,
                  found: evt.foundSoFar,
                });
              } catch {
                // ignore parse errors
              }
            } else if (eventType === 'done') {
              explicitEnd = true;
              try {
                const result = await apiClient.get<{
                  job: { draftsJson: AiMappingDraft[]; unmatchedSkusJson?: UnmatchedSku[] };
                }>(`/sku-mappings/ai-map/jobs/${id}`);
                setDrafts(result.job.draftsJson ?? []);
                setUnmatchedSkus(result.job.unmatchedSkusJson ?? []);
                setStatus('done');
              } catch (fetchErr) {
                setError(
                  fetchErr instanceof Error
                    ? fetchErr.message
                    : 'Failed to load completed job drafts',
                );
                setStatus('error');
              }
              return;
            } else if (eventType === 'error') {
              explicitEnd = true;
              let msg = 'Job failed';
              try {
                const d = JSON.parse(data) as { message?: string };
                if (d.message) msg = d.message;
              } catch {
                // use default
              }
              try {
                const result = await apiClient.get<{
                  job: { draftsJson: AiMappingDraft[]; unmatchedSkusJson?: UnmatchedSku[] };
                }>(`/sku-mappings/ai-map/jobs/${id}`);
                setDrafts(result.job.draftsJson ?? []);
                setUnmatchedSkus(result.job.unmatchedSkusJson ?? []);
              } catch {
                // ignore
              }
              setError(msg);
              setStatus('error');
              return;
            }
          }
        }

        if (!explicitEnd) {
          setError('Stream closed unexpectedly.');
          setStatus('error');
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err instanceof Error ? err.message : 'Unknown error');
        setStatus('error');
      }
    },
    [closeStream],
  );

  const start = useCallback(
    async (params: StartParams) => {
      closeStream();

      setStatus('starting');
      setProgress(null);
      setDrafts([]);
      setUnmatchedSkus([]);
      setError(null);
      setJobId(null);

      try {
        const result = await apiClient.post<{ jobId: string }>(
          '/sku-mappings/structured-map/jobs',
          {
            provider: params.provider || undefined,
            unmappedOnly: params.unmappedOnly !== false,
            ...(params.relaxOptions ? { relaxOptions: params.relaxOptions } : {}),
          },
        );

        await connectToStream(result.jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start job');
        setStatus('error');
      }
    },
    [closeStream, connectToStream],
  );

  return {
    jobId,
    status,
    progress,
    drafts,
    unmatchedSkus,
    error,
    start,
    cancel,
    reset,
    connectToStream,
  };
}
