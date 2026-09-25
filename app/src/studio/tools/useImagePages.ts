/**
 * Page-collection state for Images → PDF.
 *
 * Holds `ImagePage[]` (handles + metadata only — never decoded bytes).
 * Owns every preview object URL: created on add, revoked on remove,
 * clear, replace, and tool unmount. Revocation is synchronous in the
 * handlers so no URL outlives its page (see L-3/L-4).
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
  signal?: AbortSignal;
}

export function useImagePages() {
  const [pages, setPages] = useState<ImagePage[]>([]);
  const idRef = useRef(0);
  // Mirror of live preview URLs for synchronous revocation + unmount sweep.
  const urlsRef = useRef(new Set<string>());

  const track = (url: string) => {
    if (url) urlsRef.current.add(url);
  };
  const revoke = (url: string) => {
    if (url && urlsRef.current.delete(url)) URL.revokeObjectURL(url);
  };

  // Unmount sweep: no preview URL survives the tool.
  useEffect(() => {
    const live = urlsRef.current;
    return () => {
      for (const url of live) URL.revokeObjectURL(url);
      live.clear();
    };
  }, []);

  const nextId = () => {
    idRef.current += 1;
    return `img-${idRef.current}`;
  };

  const addEntries = useCallback(
    (entries: Array<{ file: File | Blob; name: string; source: ImageSource }>): string[] => {
      // Created OUTSIDE the updater: updaters may double-invoke under
      // StrictMode, which would leak URLs and burn ids (see usePdfFiles).
      const made = entries.map((e) => {
        const url = URL.createObjectURL(e.file);
        track(url);
        return createPage({
          id: nextId(),
          source: e.source,
          file: e.file,
          name: e.name,
          previewUrl: url,
        });
      });
      setPages((prev) => [...prev, ...made]);
      return made.map((p) => p.id);
    },
    [],
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
   * (pixel-budget normalization via `imageImport.ts`) and commits each
   * normalized page immediately — never a batch of decoded bitmaps.
   * Pages already committed survive cancellation; the AbortSignal stops
   * the run before the next file.
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
      const { outcomes, cancelled } = await runImportQueue(
        good,
        (file) => prepareImportFile(file),
        (completed, total, result) => {
          addEntries([{ file: result.file, name: result.name, source }]);
          added += 1;
          callbacks.onProgress?.(completed, total, result);
        },
        () => callbacks.signal?.aborted === true,
      );
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
    [addEntries],
  );

  const move = useCallback((id: string, dir: -1 | 1) => {
    setPages((prev) => movePage(prev, id, dir));
  }, []);

  const reorder = useCallback((ids: string[]) => {
    setPages((prev) => reorderPages(prev, ids));
  }, []);

  const remove = useCallback((id: string) => {
    setPages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) revoke(target.previewUrl);
      return removePage(prev, id);
    });
  }, []);

  const rotate = useCallback((id: string) => {
    setPages((prev) => rotatePage(prev, id));
  }, []);

  const clear = useCallback(() => {
    setPages((prev) => {
      for (const p of prev) revoke(p.previewUrl);
      return [];
    });
  }, []);

  return {
    pages,
    addFiles,
    addEntries,
    importFiles,
    move,
    remove,
    rotate,
    clear,
    reorder,
  };
}
