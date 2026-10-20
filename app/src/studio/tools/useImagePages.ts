/**
 * Page-collection state for Images → PDF.
 *
 * Holds `ImagePage[]` (handles + metadata only — never decoded bytes).
 * Owns every preview/thumb object URL: created on add, revoked on
 * remove, clear, replace, and tool unmount. Revocation runs in the event
 * handlers (outside `setPages` updaters, which must stay pure — StrictMode
 * may double-invoke them) against a `pagesRef` mirror, and is idempotent
 * via the tracked-URL set so a stale double-remove never double-revokes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createPage,
  isImageFile,
  movePage,
  removePage,
  reorderPages,
  rotatePage,
  type ImagePage,
  type ImageSource,
} from './imagePages';
import { prepareImportFile, runImportQueue, type PrepareImportResult } from './imageImport';

export type { ImagePage };

export interface ImportSummary {
  added: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  /** First per-file error message, if any. */
  firstError: string | null;
}

export interface ImportCallbacks {
  onProgress?: (completed: number, total: number, result: PrepareImportResult) => void;
  /**
   * Fires once with the pages this import actually committed (after URLs and
   * ids exist). Camera commits use it to start the build with the exact new
   * collection instead of relying on a later render.
   */
  onCommitted?: (pages: ImagePage[]) => void;
  signal?: AbortSignal;
}

interface EntryInput {
  file: File | Blob;
  name: string;
  source: ImageSource;
  /** Downscaled thumb bytes from normalization (hook mints the URL). */
  thumb?: Blob | null;
  width?: number;
  height?: number;
}

export function useImagePages() {
  const [pages, setPages] = useState<ImagePage[]>([]);
  const idRef = useRef(0);
  // Mirror of live preview/thumb URLs for synchronous revocation + unmount sweep.
  const urlsRef = useRef(new Set<string>());
  // Read mirror of the collection so handlers can revoke OUTSIDE the
  // setPages updaters (updaters must stay side-effect free).
  const pagesRef = useRef<ImagePage[]>([]);
  pagesRef.current = pages;
  // Mount guard for post-await continuations (unmount-mid-import): when
  // false, async completions must not mint URLs or call setState — the
  // unmount sweep below already ran, so any late URL would leak.
  const mountedRef = useRef(true);

  const track = (url: string) => {
    if (url) urlsRef.current.add(url);
  };
  const revoke = (url: string) => {
    if (url && urlsRef.current.delete(url)) URL.revokeObjectURL(url);
  };
  const revokePageUrls = (page: ImagePage) => {
    revoke(page.previewUrl);
    revoke(page.thumbUrl);
  };

  // Unmount sweep: no preview URL survives the tool. Also drops the
  // mount guard so post-await import continuations below skip their
  // addEntries commit (minting URLs after this sweep would leak — no
  // sweep runs again to collect them).
  useEffect(() => {
    mountedRef.current = true;
    const live = urlsRef.current;
    return () => {
      mountedRef.current = false;
      for (const url of live) URL.revokeObjectURL(url);
      live.clear();
    };
  }, []);

  const nextId = () => {
    idRef.current += 1;
    return `img-${idRef.current}`;
  };

  /**
   * Internal page-making path: returns the created pages so `importFiles`
   * can hand the exact committed batch to `onCommitted` without waiting for
   * a render. Public `addEntries` keeps its historical id[] contract.
   */
  const addEntriesWithPages = useCallback((entries: EntryInput[]): ImagePage[] => {
    // Created OUTSIDE the updater: updaters may double-invoke under
    // StrictMode, which would leak URLs and burn ids (see usePdfFiles).
    const made = entries.map((e) => {
      const url = URL.createObjectURL(e.file);
      track(url);
      let thumbUrl = '';
      if (e.thumb !== null && e.thumb !== undefined) {
        thumbUrl = URL.createObjectURL(e.thumb);
        track(thumbUrl);
      }
      return createPage({
        id: nextId(),
        source: e.source,
        file: e.file,
        name: e.name,
        previewUrl: url,
        thumbUrl,
        width: e.width,
        height: e.height,
      });
    });
    setPages((prev) => [...prev, ...made]);
    return made;
  }, []);

  const addEntries = useCallback(
    (entries: EntryInput[]): string[] => addEntriesWithPages(entries).map((p) => p.id),
    [addEntriesWithPages],
  );

  /** Adds picked files; non-JPEG/PNG entries are skipped and counted. */
  const addFiles = useCallback(
    (files: File[], source: ImageSource): { added: number; skipped: number } => {
      const good = files.filter(isImageFile);
      addEntries(good.map((file) => ({ file, name: file.name || 'image', source })));
      return { added: good.length, skipped: files.length - good.length };
    },
    [addEntries],
  );

  /**
   * Memory-safe bulk import (M3.x): prepares ONE file at a time
   * (pixel-budget normalization via `imageImport.ts`, thumb minted from
   * the same single decode) and commits the whole batch in ONE `setPages`
   * — one render for the run instead of one per file. Progress still
   * reports per file. Pages prepared before a cancellation are still
   * committed; the AbortSignal stops the run before the next file.
   */
  const importFiles = useCallback(
    async (
      files: File[],
      source: ImageSource,
      callbacks: ImportCallbacks = {},
    ): Promise<ImportSummary> => {
      const good = files.filter(isImageFile);
      const skipped = files.length - good.length;
      let added = 0;
      let firstError: string | null = null;
      const batch: EntryInput[] = [];
      const { outcomes, cancelled } = await runImportQueue(
        good,
        (file) => prepareImportFile(file),
        (completed, total, result) => {
          batch.push({
            file: result.file,
            name: result.name,
            source,
            thumb: result.thumb,
            width: result.width,
            height: result.height,
          });
          added += 1;
          callbacks.onProgress?.(completed, total, result);
        },
        () => callbacks.signal?.aborted === true,
      );
      // Mount-guarded commit: an unmount mid-import must not mint preview
      // URLs (the sweep above already ran — late URLs would leak with no
      // second sweep to collect them) nor call setState on an unmounted
      // hook. The prepared batch is dropped; its File/Blob handles are GC'd
      // (no object URLs were ever minted for them).
      if (batch.length > 0 && mountedRef.current) {
        const committed = addEntriesWithPages(batch);
        try {
          callbacks.onCommitted?.(committed);
        } catch {
          // A callback must never turn a successful import into a failure.
        }
      }
      for (const outcome of outcomes) {
        if (outcome.error !== null && firstError === null) {
          firstError = outcome.error;
        }
      }
      return {
        added,
        skipped,
        failed: outcomes.filter((o) => o.error !== null).length,
        cancelled,
        firstError,
      };
    },
    [addEntriesWithPages],
  );

  const move = useCallback((id: string, dir: -1 | 1) => {
    setPages((prev) => movePage(prev, id, dir));
  }, []);

  const reorder = useCallback((ids: string[]) => {
    setPages((prev) => reorderPages(prev, ids));
  }, []);

  const remove = useCallback((id: string) => {
    const target = pagesRef.current.find((p) => p.id === id);
    if (target !== undefined) revokePageUrls(target);
    setPages((prev) => removePage(prev, id));
  }, []);

  /**
   * Rollback helper for async commits: revokes the exact pages by identity
   * (even before the render that would update `pagesRef`) and removes them
   * from the pending state. Used when a camera import partially fails.
   */
  const removeMany = useCallback((targets: ImagePage[]) => {
    if (targets.length === 0) return;
    for (const target of targets) revokePageUrls(target);
    const ids = new Set(targets.map((p) => p.id));
    setPages((prev) => prev.filter((p) => !ids.has(p.id)));
  }, []);

  const rotate = useCallback((id: string) => {
    setPages((prev) => rotatePage(prev, id));
  }, []);

  const clear = useCallback(() => {
    const live = pagesRef.current;
    for (const p of live) revokePageUrls(p);
    setPages([]);
  }, []);

  return {
    pages,
    addFiles,
    addEntries,
    importFiles,
    move,
    remove,
    removeMany,
    rotate,
    clear,
    reorder,
  };
}
