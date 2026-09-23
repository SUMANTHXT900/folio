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
  movePageTo,
  removePage,
  rotatePage,
  type ImagePage,
  type ImageSource,
} from './imagePages';

export type { ImagePage };

export interface AddFilesResult {
  added: number;
  skipped: number;
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
    (files: File[], source: ImageSource): AddFilesResult => {
      const good = files.filter(isImageFile);
      addEntries(good.map((file) => ({ file, name: file.name || 'image', source })));
      return { added: good.length, skipped: files.length - good.length };
    },
    [addEntries],
  );

  const move = useCallback((id: string, dir: -1 | 1) => {
    setPages((prev) => movePage(prev, id, dir));
  }, []);

  const moveTo = useCallback((id: string, index: number) => {
    setPages((prev) => movePageTo(prev, id, index));
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

  return { pages, addFiles, addEntries, move, moveTo, remove, rotate, clear };
}
