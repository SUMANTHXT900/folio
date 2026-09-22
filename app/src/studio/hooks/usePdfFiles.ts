import { useCallback, useRef, useState } from 'react';
import { closeStudioDoc, openStudioDocs, type StudioDoc } from '../services/folio';

export type { StudioDoc };

/** Warn when the app holds more than this many PDF bytes (mobile safety). */
const LARGE_PAYLOAD_BYTES = 150 * 1024 * 1024;

/**
 * Studio file state — metadata ONLY in React state. PDF bytes live in
 * the folio service module store (never in state, never serialized).
 * Contract mirrors the previous hook: files/setFiles/addFiles/remove/
 * clear/busy/error/notice.
 */
export function usePdfFiles() {
  const [files, setFiles] = useState<StudioDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Ref mirror (no side effects inside state updaters; StrictMode-safe).
  const filesRef = useRef<StudioDoc[]>([]);
  const sync = useCallback((next: StudioDoc[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  /** setFiles that keeps the ref mirror in sync (supports updaters). */
  const setFilesSynced = useCallback(
    (update: StudioDoc[] | ((prev: StudioDoc[]) => StudioDoc[])) => {
      const next = typeof update === 'function' ? update(filesRef.current) : update;
      sync(next);
    },
    [sync],
  );

  const addFiles = useCallback(
    async (f: File[]) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const pdfs = f.filter(
          (x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'),
        );
        if (pdfs.length < f.length) {
          setError('Skipped non-PDF file(s).');
        }
        if (pdfs.length === 0) return;
        const incomingBytes = pdfs.reduce((s, x) => s + x.size, 0);
        const existingBytes = filesRef.current.reduce((s, x) => s + x.sizeBytes, 0);
        if (incomingBytes + existingBytes > LARGE_PAYLOAD_BYTES) {
          setNotice(
            'Heads up: that is a lot of PDF data held in memory. On phones, consider working with fewer or smaller files at once.',
          );
        }
        const docs = await openStudioDocs(pdfs);
        sync([...filesRef.current, ...docs]);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read those files.');
      } finally {
        setBusy(false);
      }
    },
    [sync],
  );

  const remove = useCallback(
    (id: string) => {
      sync(filesRef.current.filter((f) => f.id !== id));
      void closeStudioDoc(id);
    },
    [sync],
  );

  const clear = useCallback(() => {
    const prev = filesRef.current;
    sync([]);
    for (const f of prev) void closeStudioDoc(f.id);
  }, [sync]);

  return {
    files,
    setFiles: setFilesSynced,
    addFiles,
    remove,
    clear,
    busy,
    setBusy,
    error,
    setError,
    notice,
  };
}
