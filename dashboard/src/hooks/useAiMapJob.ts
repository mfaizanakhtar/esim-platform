import { useState, useRef, useCallback } from 'react';
import type { AiMappingDraft } from '@/lib/types';
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
};

export function useAiMapJob() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<JobStatus>('idle');
  const [progress, setProgress] = useState<JobProgress | null>(null);
  const [drafts, setDrafts] = useState<AiMappingDraft[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Holds the active fetch AbortController for the SSE stream
  const abortRef = useRef<AbortController | null>(null);

  const closeStream = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    closeStream();
    // Background job keeps running — user can resume from Past Jobs panel
    setStatus('idle');
    setProgress(null);
  }, [closeStream]);

  const reset = useCallback(() => {
    closeStream();
    setJobId(null);
    setStatus('idle');
    setProgress(null);
    setDrafts([]);
    setError(null);
  }, [closeStream]);

  /**
   * Connect to an existing job's SSE stream (e.g. when resuming from Past Jobs).
   * Fetches final drafts from DB when the stream emits 'done'.
   */
  const connectToStream = useCallback(
    async (id: string) => {
      closeStream();

      const controller = new AbortController();
      abortRef.current = controller;

      setJobId(id);
      setStatus('running');
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
                setProgress({ batch: evt.batch, totalBatches: evt.totalBatches, found: evt.foundSoFar });
              } catch {
                // ignore parse errors
              }
            } else if (eventType === 'done') {
              explicitEnd = true;
              // Fetch full drafts from DB
              try {
                const result = await apiClient.get<{ job: { draftsJson: AiMappingDraft[] } }>(
                  `/sku-mappings/ai-map/jobs/${id}`,
                );
                setDrafts(result.job.draftsJson ?? []);
              } catch {
                // leave drafts empty — user will see empty review
              }
              setStatus('done');
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
              setError(msg);
              setStatus('error');
              return;
            }
          }
        }

        if (!explicitEnd) setStatus('done');
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return; // cancelled
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
      setError(null);
      setJobId(null);

      try {
        const result = await apiClient.post<{ jobId: string }>('/sku-mappings/ai-map/jobs', {
          provider: params.provider || undefined,
          unmappedOnly: params.unmappedOnly !== false,
        });

        await connectToStream(result.jobId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start job');
        setStatus('error');
      }
    },
    [closeStream, connectToStream],
  );

  return { jobId, status, progress, drafts, error, start, cancel, reset, connectToStream };
}
