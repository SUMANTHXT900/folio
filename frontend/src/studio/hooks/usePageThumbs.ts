import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { studioPreview, studioThumbWindow } from '../services/folio';

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
 * fetches one full-resolution URL (caller owns revocation).
 *
 * Engine mapping: each wave is one bounded-concurrency
 * `generateThumbnails` call (concurrency 2) — never N concurrent
 * renders, never whole-document canvas arrays. Canvases are released
 * as their object URLs are encoded; URL storage is LRU-bounded
 * (6 documents) inside the service.
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

  const paint = useCallback((total: number) => {
    const arr = arrRef.current;
    if (abortRef.current?.signal.aborted) return;
    setThumbs([...arr]);
    setProgress({ done: arr.filter(Boolean).length, total });
  }, []);

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
            for (const [p2, url] of map) arrRef.current[p2 - 1] = url;
            paint(total);
          }
          start = end + 1;
        }
        if (!ac.signal.aborted && arrRef.current.every(Boolean)) setProgress(null);
      } catch {
        // aborted or closed — tools treat empty holes as pending
      } finally {
        if (jobRef.current !== null && ac.signal.aborted) jobRef.current = null;
      }
    },
    [paint],
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
        setThumbs([...arrRef.current]);
        setLoading(false);
        jobRef.current = null;

        if (first < total && !ac.signal.aborted) {
          setProgress({ done: map.size, total });
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
        for (const [p2, url] of map) arrRef.current[p2 - 1] = url;
        paint(total);
      } catch {
        return;
      }
    }
    if (!ac.signal.aborted && arrRef.current.every(Boolean)) setProgress(null);
  }, [paint]);

  const cancel = useCallback(() => {
    stop();
    setLoading(false);
    setProgress(null);
  }, [stop]);

  /** Full-res preview URL via the render engine. Caller owns revocation. */
  const renderPreview = useCallback(async (docId: string, pageNum: number): Promise<string> => {
    return studioPreview(docId, pageNum);
  }, []);

  return { thumbs: memoizedThumbs, load, fillAll, loading, progress, cancel, renderPreview };
}
