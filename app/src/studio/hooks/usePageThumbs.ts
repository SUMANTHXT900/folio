import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getThumbGeneration,
  studioPreview,
  studioThumbWindow,
  subscribeThumbEvictions,
  type StudioPreviewJob,
} from '../services/folio';
import { pageWindows } from '../../rendering/pageWindows';

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
  /** Every in-flight thumb window: stop() cancels all of them, not just the latest. */
  const liveJobs = useRef<Set<{ cancel: () => void }>>(new Set());
  /** Bumped on every stop(): stale waves observe the mismatch and drop their results. */
  const genRef = useRef(0);
  const arrRef = useRef<string[]>([]);
  const docRef = useRef<string | null>(null);
  const totalRef = useRef(0);
  /** Incrementally published page count — never recomputed by scanning. */
  const doneRef = useRef(0);
  /** Pages that failed to render: marked, never retried by later waves. */
  const failedRef = useRef<Set<number>>(new Set());
  /**
   * Requested render box for this document's windows (F-23): pick grids
   * display far above list size, so Split loads with `thumbGridBox()`.
   * Stored on load so background-fill and Show-all waves render holes at
   * the same resolution — never a mix of sharp and upscaled tiles.
   */
  const boxRef = useRef<number | undefined>(undefined);

  const memoizedThumbs = useMemo(() => thumbs, [thumbs]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    genRef.current += 1;
    for (const job of liveJobs.current) {
      try {
        job.cancel();
      } catch {
        // Best effort.
      }
    }
    liveJobs.current.clear();
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

  /** Runs one window with live-job tracking + generation guard. */
  const runWindow = useCallback(
    async (
      ac: AbortController,
      gen: number,
      docId: string,
      pages: number[],
      box?: number,
    ): Promise<Map<number, string> | null> => {
      // Box is forwarded only when the caller passes one: the two-arg call
      // keeps the list-tier default (and existing mock arity) untouched.
      const effectiveBox = box ?? boxRef.current;
      const job =
        effectiveBox === undefined
          ? studioThumbWindow(docId, pages)
          : studioThumbWindow(docId, pages, { box: effectiveBox });
      liveJobs.current.add(job);
      try {
        const map = await job.done;
        if (ac.signal.aborted || gen !== genRef.current) return null;
        return map;
      } finally {
        liveJobs.current.delete(job);
      }
    },
    [],
  );

  /**
   * Marks requested pages the window did not resolve as failed so later
   * waves never retry them (per-page fault isolation, hook side).
   */
  const markFailures = useCallback((requested: number[], resolved: Map<number, string>) => {
    for (const page of requested) {
      if (!resolved.has(page)) {
        failedRef.current.add(page);
      }
    }
  }, []);

  /** Detached idle-paced background fill. Never awaited by tools. */
  const backgroundFill = useCallback(
    async (ac: AbortController, gen: number, startAt: number) => {
      const docId = docRef.current;
      if (docId === null) return;
      const total = totalRef.current;
      // Waves route through the shared `pageWindows` primitive (same
      // windowing the future viewer reuses) — never ad-hoc slicing.
      const windows = pageWindows(total, WAVE);
      let wi = Math.max(0, Math.floor((startAt - 1) / WAVE));
      try {
        while (wi < windows.length && !ac.signal.aborted && gen === genRef.current) {
          await new Promise((r) => setTimeout(r, 60)); // soft pacing
          if (ac.signal.aborted || gen !== genRef.current) return;
          const window = windows[wi] as number[];
          wi += 1;
          const pages = window.filter((n) => !arrRef.current[n - 1] && !failedRef.current.has(n));
          if (pages.length > 0) {
            // Capture the eviction generation before the await: an LRU or
            // per-doc-cap evict mid-flight revokes URLs and blanks `arrRef`
            // via the subscription above. The post-await recheck drops the
            // superseded window so revoked URLs never repopulate state.
            const thumbGen = getThumbGeneration(docId);
            const map = await runWindow(ac, gen, docId, pages);
            if (map === null) return;
            if (
              ac.signal.aborted ||
              gen !== genRef.current ||
              docRef.current !== docId ||
              getThumbGeneration(docId) !== thumbGen
            )
              return;
            markFailures(pages, map);
            const dirty: number[] = [];
            for (const [p2, url] of map) {
              if (!arrRef.current[p2 - 1]) {
                arrRef.current[p2 - 1] = url;
                dirty.push(p2);
              }
            }
            publishDirty(dirty, total);
          }
        }
        if (!ac.signal.aborted && gen === genRef.current && doneRef.current >= total)
          setProgress(null);
      } catch {
        // aborted or closed — tools treat empty holes as pending
      }
    },
    [markFailures, publishDirty, runWindow],
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
      box?: number,
    ): Promise<string[]> => {
      // Box validation is a true no-op: it runs before `stop()` so an
      // invalid call neither cancels in-flight work nor marks pages failed
      // (a poisoned `failedRef` would break every later load of the doc).
      if (box !== undefined && (typeof box !== 'number' || !Number.isFinite(box) || box <= 0)) {
        throw new Error(`Invalid thumbnail box: ${String(box)}`);
      }
      stop();
      const ac = new AbortController();
      abortRef.current = ac;
      const gen = genRef.current;
      docRef.current = docId;
      totalRef.current = total;
      boxRef.current = box;
      if (!Number.isInteger(total) || total < 1) {
        setLoading(false);
        setProgress(null);
        return [];
      }
      arrRef.current = new Array(total).fill('');
      doneRef.current = 0;
      failedRef.current = new Set();

      setLoading(true);
      setProgress({ done: 0, total });
      try {
        // First wave routes through `pageWindows` too — one primitive for
        // every wave in this hook.
        const first = Math.min(Math.max(1, initialCount), total);
        const firstPages = (pageWindows(total, Math.min(first, 500))[0] as number[]).slice(
          0,
          first,
        );
        const map = await runWindow(ac, gen, docId, firstPages);
        if (map === null) {
          // Aborted/superseded: only the still-current load owns the
          // spinner — a newer load keeps it, cancel() already dropped it.
          if (gen === genRef.current && abortRef.current === ac) setLoading(false);
          return [];
        }
        markFailures(firstPages, map);
        for (const [p2, url] of map) arrRef.current[p2 - 1] = url;
        doneRef.current += map.size;
        setThumbs([...arrRef.current]);
        setLoading(false);

        if (first < total && !ac.signal.aborted && gen === genRef.current) {
          setProgress({ done: doneRef.current, total });
          void backgroundFill(ac, gen, first + 1);
        } else {
          setProgress(null);
        }
        return [...arrRef.current];
      } catch {
        // Superseded or cancelled: the newer load (or cancel()) owns the
        // spinner — never clobber it. A still-current abort or failure
        // drops the spinner here so it can never stick.
        if (gen !== genRef.current || abortRef.current !== ac) return [];
        setLoading(false);
        if ((ac.signal as AbortSignal).aborted) return [];
        throw new Error('Could not render page previews.');
      }
    },
    [backgroundFill, markFailures, runWindow, stop],
  );

  /** Show All / Load more: resume ONLY missing pages (failed pages stay marked). */
  const fillAll = useCallback(async (): Promise<void> => {
    const ac = abortRef.current;
    const docId = docRef.current;
    if (ac === null || docId === null || ac.signal.aborted) return;
    // Mutual exclusion with the detached background fill: both loops issue
    // concurrency-2 engine windows, so running both would double the render
    // concurrency. Bumping the generation supersedes the background loop
    // (its next liveness check drops it); a second fillAll supersedes the
    // first the same way. The first wave (load) is superseded too when it
    // is still in flight — this loop renders every hole anyway.
    genRef.current += 1;
    const gen = genRef.current;
    // Free the engine slots now: the superseded background window keeps
    // rendering until its promise settles unless its job is cancelled.
    // (Its late result is still dropped by the generation checks.)
    for (const job of liveJobs.current) {
      try {
        job.cancel();
      } catch {
        // Best effort.
      }
    }
    const total = totalRef.current;
    for (const window of pageWindows(total, WAVE)) {
      if (ac.signal.aborted || gen !== genRef.current) return;
      const pages = (window as number[]).filter(
        (n) => !arrRef.current[n - 1] && !failedRef.current.has(n),
      );
      if (pages.length === 0) continue;
      try {
        const thumbGen = getThumbGeneration(docId);
        const map = await runWindow(ac, gen, docId, pages);
        if (map === null) return;
        if (
          ac.signal.aborted ||
          gen !== genRef.current ||
          docRef.current !== docId ||
          getThumbGeneration(docId) !== thumbGen
        )
          return;
        markFailures(pages, map);
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
    if (gen !== genRef.current || ac.signal.aborted) return;
    // Owns the spinner when it superseded an in-flight first wave.
    setLoading(false);
    if (doneRef.current >= total) setProgress(null);
  }, [markFailures, publishDirty, runWindow]);

  const cancel = useCallback(() => {
    stop();
    setLoading(false);
    setProgress(null);
  }, [stop]);

  /** Full-res preview job via the render engine. Borrowed — never revoke. */
  const renderPreview = useCallback((docId: string, pageNum: number): StudioPreviewJob => {
    return studioPreview(docId, pageNum);
  }, []);

  return { thumbs: memoizedThumbs, load, fillAll, loading, progress, cancel, renderPreview };
}
