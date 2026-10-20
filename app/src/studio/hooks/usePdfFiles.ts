import { useCallback, useRef, useState } from 'react';
import { closeStudioDoc, openStudioDocs, type StudioDoc } from '../services/folio';

/**
 * Best-effort close for fire-and-forget call sites (`remove`, `clear`):
 * frees bytes + the rendering document + URLs, then logs-and-swallows —
 * a close failure must never surface as an unhandled rejection from a
 * `void` handler, and there is no per-file UI left to report it to (the
 * handle is already gone from state).
 */
function closeQuietly(id: string): void {
  void closeStudioDoc(id).catch((error: unknown) => {
    console.warn(`closeStudioDoc(${id}) failed:`, error);
  });
}

export type { StudioDoc };

/** Refuse when the app would hold more than this many PDF bytes (mobile safety).
 *
 * NOTE — true resident cost is a multiple of file bytes, not 1×: the
 * folio service module store holds one full copy AND PDF.js owns a second
 * copy for rendering (PERFORMANCE.md P0.2 measured the staging slice and
 * shelved its removal, so both copies stay), plus per-page render bitmaps
 * and thumbnail/preview object URLs. Budget roughly 3–4× file bytes of
 * RSS per open document on desktop; a phone tab feels pressure sooner,
 * hence this file-bytes gate well below any single-copy limit.
 *
 * Enforcing (was advisory): over-limit batches are blocked with an honest
 * message BEFORE any bytes are read — never opened with a "heads up". The
 * engine's 100MB per-file cap (`MAX_PDF_BYTES` in
 * `engine/src/processing/pdf/core/loader.rs`) stays as the backstop for
 * single files that clear this total-bytes gate.
 */
const LARGE_PAYLOAD_BYTES = 150 * 1024 * 1024;

/**
 * Studio file state — metadata ONLY in React state. PDF bytes live in
 * the folio service module store (never in state, never serialized).
 * Contract mirrors the previous hook: files/setFiles/addFiles/remove/
 * clear/busy/error/notice, plus `errorDetail` — the structured intake
 * failure (code/details) behind the `error` display string.
 */
export function usePdfFiles() {
  const [files, setFiles] = useState<StudioDoc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState<string | null>(null);
  /**
   * Structured intake failure behind the display string: `error` stays a
   * plain renderable string (callers interpolate it into `<p>`), while
   * this keeps the thrown object's code/details/engineMessage for
   * diagnostics instead of degrading to message-only. Populated only by
   * `addFiles`; cleared whenever `setError` runs.
   */
  const [errorDetail, setErrorDetail] = useState<unknown>(null);
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

  /** setError that keeps the structured detail in sync (clear on any set). */
  const setError = useCallback((next: string | null) => {
    setErrorState(next);
    setErrorDetail(null);
  }, []);

  const addFiles = useCallback(
    async (f: File[]) => {
      setBusy(true);
      setErrorState(null);
      setErrorDetail(null);
      setNotice(null);
      try {
        const pdfs = f.filter(
          (x) => x.type === 'application/pdf' || x.name.toLowerCase().endsWith('.pdf'),
        );
        if (pdfs.length < f.length) {
          setErrorState('Skipped non-PDF file(s).');
        }
        if (pdfs.length === 0) return;
        const incomingBytes = pdfs.reduce((s, x) => s + x.size, 0);
        const existingBytes = filesRef.current.reduce((s, x) => s + x.sizeBytes, 0);
        if (incomingBytes + existingBytes > LARGE_PAYLOAD_BYTES) {
          // Enforcing gate: refuse before any bytes are read. The message
          // states the limit and the reason (in-memory multiples) and the
          // batch is never opened — no advisory "heads up" while proceeding.
          setErrorState(
            'Those files were not opened: together they exceed the 150MB in-memory limit. Folio holds PDFs in memory while you work, so add fewer or smaller files at once.',
          );
          return;
        }
        const docs = await openStudioDocs(pdfs);
        sync([...filesRef.current, ...docs]);
      } catch (e) {
        // Display string unchanged (message-only callers keep working);
        // the structured object is retained alongside for code/details.
        setErrorState(e instanceof Error ? e.message : 'Could not read those files.');
        setErrorDetail(e instanceof Error ? e : null);
      } finally {
        setBusy(false);
      }
    },
    [sync],
  );

  const remove = useCallback(
    (id: string) => {
      sync(filesRef.current.filter((f) => f.id !== id));
      closeQuietly(id);
    },
    [sync],
  );

  const clear = useCallback(() => {
    const prev = filesRef.current;
    sync([]);
    for (const f of prev) closeQuietly(f.id);
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
    /** Structured intake failure (code/details) behind `error`; null unless `addFiles` threw. */
    errorDetail,
    notice,
  };
}
