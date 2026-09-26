import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { studioPreview, studioThumbWindow, subscribeThumbEvictions } from '../services/folio';

/** Pages rendered in the blocking first phase — matches grid PAGE_LIMIT. */
export const THUMB_INITIAL = 24;

/** Background-fill wave size (bounded engine windows). */
const WAVE = 24;

/**
 * Page thumbnails as display URLs, backed by the Folio thumbnail engine.
 *
 * Contract mirrors the previous hook: `thumbs` is a dense array aligned
 * with page numbers (`''` = not yet rendered), `load` resolves the
 * first wave fast while the rest streams in paced background waves,
 * `fillAll` resumes holes, `cancel` aborts everything, `renderPreview`
 * fetches one full-resolution URL (service-owned, borrowed — never
 * revoke the result).
 *
 * Engine mapping: each wave is one bounded-concurrency
 * `generateThumbnails` call (concurrency 2) — never N concurrent
 * renders, never whole-document canvas arrays. Canvases are released
 * as their object URLs are encoded; URL storage is LRU-bounded
 * (6 documents) inside the service.
 *
 * Publishing is dirty-index only: every wave patches just its pages
 * into state and advances an incremental done counter — no full-array
 * filter scan per wave. On service eviction of the current document
 * the array is invalidated (blanked) so a revoked URL is never served;
 * holes re-render through the normal fill paths.
 */
export function usePageThumbs() {
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const jobRef = useRef<{ cancel: () => void } | null>(null);
  const arrRef = useRef<string[]>([]);
  const docRef = useRef<string | null>(null);
  const totalRef = useRef(0);
  /** Incrementally published page count — never recomputed by scanning. */
  const doneRef = useRef(0);

  const memoizedThumbs = useMemo(() => thumbs, [thumbs]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    try {
      jobRef.current?.cancel();
    } catch {
      // Best effort.
    }
    jobRef.current = null;
  }, []);

  useEffect(() => () => stop(), [stop]);

  /**
   * Publishes ONLY dirty pages: patches them onto the previous state
   * and advances the incremental counter. `dirty` holds 1-based page
   * numbers already written into `arrRef`.
   */
  const publishDirty = useCallback((dirty: number[], total: number) => {
    if (abortRef.current?.signal.aborted) return;
    if (dirty.length === 0) return;
    doneRef.current += dirty.length;
    const done = doneRef.current;
    setThumbs((prev) => {
      const next = prev.length === total ? prev.slice() : arrRef.current.slice();
      for (const page of dirty) {
        const url = arrRef.current[page - 1];
        if (url !== undefined && url !== '') {
          next[page - 1] = url;
        }
      }
      return next;
    });
    setProgress({ done, total });
  }, []);

  // Eviction invalidation: the service revokes thumbnail URLs on LRU
  // evict / per-doc cap evict / close and notifies here. Blank the array
  // for the evicted document so revoked URLs are never rendered; the
  // fill paths below re-request the holes on demand.
  useEffect(
    () =>
      subscribeThumbEvictions((evictedDocId) => {
        if (evictedDocId !== docRef.current) return;
        arrRef.current = new Array<string>(totalRef.current).fill('');
        doneRef.current = 0;
        const total = totalRef.current;
        setThumbs(new Array<string>(total).fill(''));
        setProgress({ done: 0, total });
      }),
    [],
  );

  /** Detached idle-paced background fill. Never awaited by tools. */
  const backgroundFill = useCallback(
    async (ac: AbortController, startAt: number) => {
      const docId = docRef.current;
      if (docId === null) return;
      let start = startAt;
      const total = totalRef.current;
      try {
        while (start <= total && !ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 60)); // soft pacing
          if (ac.signal.aborted) return;
          const end = Math.min(start + WAVE - 1, total);
          const pages: number[] = [];
          for (let n = start; n <= end; n += 1) {
            if (!arrRef.current[n - 1]) pages.push(n);
          }
          if (pages.length > 0) {
            const job = studioThumbWindow(docId, pages);
            jobRef.current = job;
            const map = await job.done;
            if (ac.signal.aborted) return;
            const dirty: number[] = [];
            for (const [p2, url] of map) {
              if (!arrRef.current[p2 - 1]) {
                arrRef.current[p2 - 1] = url;
                dirty.push(p2);
              }
            }
            publishDirty(dirty, total);
          }
          start = end + 1;
        }
        if (!ac.signal.aborted && doneRef.current >= total) setProgress(null);
      } catch {
        // aborted or closed — tools treat empty holes as pending
      } finally {
        if (jobRef.current !== null && ac.signal.aborted) jobRef.current = null;
      }
    },
    [publishDirty],
  );

  /**
   * Phase 1: resolve the first wave fast; remaining pages stream on a
   * detached loop (never awaited by tools).
   */
  const load = useCallback(
    async (
      docId: string,
      total: number,
      initialCount: number = THUMB_INITIAL,
    ): Promise<string[]> => {
      stop();
      const ac = new AbortController();
      abortRef.current = ac;
      docRef.current = docId;
      totalRef.current = total;
      arrRef.current = new Array(total).fill('');
      doneRef.current = 0;

      setLoading(true);
      setProgress({ done: 0, total });
      try {
        const first = Math.min(initialCount, total);
        const firstPages: number[] = [];
        for (let n = 1; n <= first; n += 1) firstPages.push(n);
        const job = studioThumbWindow(docId, firstPages);
        jobRef.current = job;
        const map = await job.done;
        if (ac.signal.aborted) return [];
        for (const [p2, url] of map) arrRef.current[p2 - 1] = url;
        doneRef.current += map.size;
        setThumbs([...arrRef.current]);
        setLoading(false);
        jobRef.current = null;

        if (first < total && !ac.signal.aborted) {
          setProgress({ done: doneRef.current, total });
          void backgroundFill(ac, first + 1);
        } else {
          setProgress(null);
        }
        return [...arrRef.current];
      } catch {
        if ((ac.signal as AbortSignal).aborted) return [];
        throw new Error('Could not render page previews.');
      }
    },
    [backgroundFill, stop],
  );

  /** Show All / Load more: resume ONLY missing pages. */
  const fillAll = useCallback(async (): Promise<void> => {
    const ac = abortRef.current;
    const docId = docRef.current;
    if (ac === null || docId === null || ac.signal.aborted) return;
    const total = totalRef.current;
    const holes: number[] = [];
    for (let n = 1; n <= total; n += 1) {
      if (!arrRef.current[n - 1]) holes.push(n);
    }
    for (let s = 0; s < holes.length && !ac.signal.aborted; s += WAVE) {
      try {
        const job = studioThumbWindow(docId, holes.slice(s, s + WAVE));
        jobRef.current = job;
        const map = await job.done;
        if (ac.signal.aborted) return;
        const dirty: number[] = [];
        for (const [p2, url] of map) {
          if (!arrRef.current[p2 - 1]) {
            arrRef.current[p2 - 1] = url;
            dirty.push(p2);
          }
        }
        publishDirty(dirty, total);
      } catch {
        return;
      }
    }
    if (!ac.signal.aborted && doneRef.current >= total) setProgress(null);
  }, [publishDirty]);

  const cancel = useCallback(() => {
    stop();
    setLoading(false);
    setProgress(null);
  }, [stop]);

  /** Full-res preview URL via the render engine. Borrowed — never revoke. */
  const renderPreview = useCallback(async (docId: string, pageNum: number): Promise<string> => {
    return studioPreview(docId, pageNum);
  }, []);

  return { thumbs: memoizedThumbs, load, fillAll, loading, progress, cancel, renderPreview };
}
