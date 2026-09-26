import { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ToolHeading,
  Button,
  Card,
  Progress,
  ResultMeta,
  ErrorBlock,
  formatBytes,
} from '../components/ui';
import { DownloadCard } from '../components/DownloadCard';
import { smartOutputName } from '../components/downloadNaming';
import {
  releaseStagedBytes,
  runStudioOperation,
  formatDurationMs,
  stageStudioBytes,
  studioShareAvailable,
  type StudioJob,
} from '../services/folio';
import { useImagePages } from './useImagePages';
import { PageGrid } from './PageGrid';
import { CameraCapture } from './CameraCapture';
import { browserImageRenderer, preparePageBytes } from './imagePrepare';
import { clearScans, releaseScan, retainOriginal } from './scan/scanStore';

const ICON = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20" />
  </svg>
);

const ACCEPT = 'image/jpeg,image/png,.jpg,.jpeg,.png';

/**
 * Images → PDF page assembly: uploads + camera captures join one ordered
 * page collection (preview, reorder, remove, rotate), then build through
 * the Folio engine (`pdf.images_to_pdf`, one page per image, in listed
 * order). Image bytes are staged in the service store only for the run
 * (never in React state); pages hold File/Blob handles + preview URLs.
 */
export default function ImagesTool() {
  const { pages, addEntries, importFiles, move, remove, rotate, clear, reorder } = useImagePages();
  const [pageSize, setPageSize] = useState<'fit' | 'standard'>('fit');
  const [cameraMode, setCameraMode] = useState(false);
  // Session boundary: ids captured since the scanner was opened. Retake
  // only ever touches these — never pre-session pages. Reset on Done.
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [meta, setMeta] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const jobRef = useRef<StudioJob | null>(null);
  const moreInputRef = useRef<HTMLInputElement>(null);
  const [cameraSupported] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
  );

  const addUploads = async (incoming: File[]) => {
    // Same normalized path as scanner imports: pixel-budget resize +
    // PNG→JPEG conversion, one file at a time. Raw gallery PNGs would
    // otherwise embed as uncompressed RGB downstream (100 MB+ PDFs).
    setImporting('Preparing images…');
    try {
      const summary = await importFiles(incoming, 'upload', {
        onProgress: (completed, total) =>
          setImporting(`Preparing images… ${completed} of ${total}`),
      });
      if (summary.skipped > 0) {
        setError(new Error('Skipped non-image file(s) — JPEG and PNG only.'));
      } else if (summary.failed > 0) {
        setError(
          new Error(
            summary.firstError !== null
              ? `Couldn't add ${summary.failed} image(s): ${summary.firstError}`
              : `Couldn't add ${summary.failed} image(s).`,
          ),
        );
      } else {
        setError(null);
      }
    } finally {
      setImporting(null);
    }
  };

  /**
   * Scanner import: memory-safe sequential normalization (one decode at
   * a time, pixel-budget resize) with per-file progress and cancellation.
   */
  const onCameraImport = async (
    files: File[],
    progress: (completed: number, total: number, name: string) => void,
    signal: AbortSignal,
  ) => {
    setError(null);
    const summary = await importFiles(files, 'camera', {
      signal,
      onProgress: (completed, total, result) => {
        progress(completed, total, result.name);
      },
    });
    if (summary.failed > 0 && summary.firstError !== null) {
      setError(new Error(`Couldn't import ${summary.failed} image(s): ${summary.firstError}`));
    }
    return summary;
  };

  const onCapture = (file: File) => {
    const [id] = addEntries([{ file, name: file.name, source: 'camera' }]);
    if (id !== undefined) setSessionIds((prev) => [...prev, id]);
  };
  void onCapture;

  /**
   * Accepted scan: the processed (or original) file becomes the page;
   * the pre-scan capture is retained under the page id for Use-original
   * provenance. Released on page remove / clear-all (never on scanner
   * close — lifetime follows the page).
   */
  const onScanAccept = (entry: { file: File; original: File | null; name: string }) => {
    const [id] = addEntries([{ file: entry.file, name: entry.name, source: 'camera' }]);
    if (id === undefined) return;
    if (entry.original !== null) retainOriginal(id, entry.original, entry.name);
    setSessionIds((prev) => [...prev, id]);
  };

  const onRemovePage = (id: string) => {
    releaseScan(id);
    remove(id);
  };

  const onClearAll = () => {
    clearScans();
    clear();
  };

  const onRetake = () => {
    setSessionIds((prev) => {
      const target = prev[prev.length - 1];
      if (target !== undefined) {
        releaseScan(target);
        remove(target);
      }
      return prev.slice(0, -1);
    });
  };

  // Session thumbnails for the scanner strip (URLs only, no byte copies).
  // Filters the live collection so removals are reflected immediately.
  const sessionPages = pages.filter((p) => sessionIds.includes(p.id));

  // A completed PDF is stale the moment the collection or page-size
  // policy changes (import/capture/remove/reorder/rotate/clear). Clearing
  // the completion card brings Build PDF back AND releases the previous
  // output Blob (P2) — post-build imports are a first-class flow now that
  // the scanner can import from inside the camera surface. (On mount the
  // state is already empty; these setters are no-ops.)
  useEffect(() => {
    setDone(null);
    setMeta([]);
  }, [pages, pageSize]);

  const onBuild = async () => {
    if (pages.length === 0) return;
    setWorking(true);
    setError(null);
    setDone(null);
    setMeta([]);
    setFraction(null);
    setStage(null);
    const staged: string[] = [];
    try {
      for (const page of pages) {
        const prepared = await preparePageBytes(page, browserImageRenderer);
        staged.push(stageStudioBytes(prepared.name, prepared.bytes));
      }
      const job = runStudioOperation(
        'pdf.images_to_pdf',
        staged,
        { pageSize, backgroundRgb: [255, 255, 255] },
        {
          onProgress: (p) => {
            setFraction(p.fraction);
            setStage(p.label);
          },
        },
      );
      jobRef.current = job;
      const out = await job.done;
      jobRef.current = null;
      const first = out.outputs[0];
      const name = smartOutputName(
        'images',
        pages.map((p) => p.name),
      );
      // ONE Blob for download, re-download, and share (P2): the
      // engine output bytes are not retained afterwards, and no second
      // Blob is built. DownloadCard owns its object URL (revoked on
      // replace/unmount); no auto-download fires — the card's anchor
      // is the trigger. The Blob stays only while this completion card
      // is displayed — required for save-again/share; cleared on
      // rebuild, clear, unmount.
      const blob = new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' });
      setDone({ name, blob });
      const summary = out.summary;
      const imageCount =
        summary !== undefined && 'imageCount' in summary && typeof summary.imageCount === 'number'
          ? summary.imageCount
          : pages.length;
      const pageCount =
        summary !== undefined && 'pageCount' in summary ? summary.pageCount : imageCount;
      setMeta([
        `${imageCount} image${imageCount === 1 ? '' : 's'} → ${pageCount}-page PDF`,
        `${formatBytes(first.byteLength)}`,
        `Completed in ${formatDurationMs(out.durationMs)}`,
      ]);
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setError(new Error('Image build cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setFraction(null);
      setStage(null);
      for (const id of staged) releaseStagedBytes(id);
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onBuild's catch/finally.
    }
  };

  return (
    <div className="py-6">
      <ToolHeading
        icon={ICON}
        name="Images to PDF"
        desc="Assemble pages from files or camera, arrange them in order, then build one PDF."
      />

      {pages.length === 0 && !cameraMode ? (
        <div className="space-y-4">
          <EntryCard
            onFiles={addUploads}
            cameraSupported={cameraSupported}
            onCamera={() => {
              setSessionIds([]);
              setCameraMode(true);
            }}
          />
          {error !== null && <ErrorBlock error={error} />}
        </div>
      ) : (
        <div className="space-y-5">
          {cameraMode ? (
            <CameraCapture
              onScanAccept={onScanAccept}
              onImportFiles={onCameraImport}
              onRetake={onRetake}
              onDone={() => {
                setCameraMode(false);
                setSessionIds([]);
              }}
              sessionPages={sessionPages.map((p) => ({
                id: p.id,
                previewUrl: p.previewUrl,
                name: p.name,
              }))}
            />
          ) : (
            cameraSupported && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSessionIds([]);
                  setCameraMode(true);
                }}
                className="w-full"
              >
                Scan with camera
              </Button>
            )
          )}

          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink-700 dark:text-paper-100">
                {pages.length} page{pages.length === 1 ? '' : 's'} · top-to-bottom is PDF order
              </p>
              <button
                onClick={onClearAll}
                className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-ink-300 dark:hover:bg-red-950/30"
              >
                Clear all
              </button>
            </div>
            {pages.length > 0 ? (
              <PageGrid
                pages={pages}
                onMove={move}
                onReorder={reorder}
                onRemove={onRemovePage}
                onRotate={rotate}
              />
            ) : (
              <p className="text-sm text-ink-400 dark:text-ink-300">
                No pages yet — add images below or capture with the camera.
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                ref={moreInputRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={(e) => {
                  void addUploads(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              {importing !== null && (
                <p role="status" className="text-xs text-ink-400 dark:text-ink-300">
                  {importing}
                </p>
              )}
              <Button variant="ghost" onClick={() => moreInputRef.current?.click()}>
                Add images
              </Button>{' '}
              {cameraSupported && !cameraMode && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSessionIds([]);
                    setCameraMode(true);
                  }}
                >
                  Scan more
                </Button>
              )}
            </div>
            <p className="mb-3 mt-4 text-sm font-medium text-ink-700 dark:text-paper-100">
              Page size policy
            </p>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="studio-images-page-size"
                  checked={pageSize === 'fit'}
                  onChange={() => setPageSize('fit')}
                />
                Fit image (page = image size)
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="studio-images-page-size"
                  checked={pageSize === 'standard'}
                  onChange={() => setPageSize('standard')}
                />
                A4 (fit inside, centered)
              </label>
            </div>
          </Card>

          {!done && pages.length > 0 && (
            <div className="flex items-center gap-3">
              <Button onClick={onBuild} disabled={working} className="w-full">
                {working
                  ? 'Building…'
                  : `Build PDF · ${pages.length} image${pages.length === 1 ? '' : 's'}`}
              </Button>
              {working && (
                <Button variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              )}
            </div>
          )}
          {working && fraction !== null && (
            <div className="w-full max-w-xs">
              <Progress value={fraction * 100} label={stage ?? 'Working…'} />
            </div>
          )}

          {error !== null && <ErrorBlock error={error} />}
          {done && (
            <>
              <DownloadCard
                blob={done.blob}
                suggestedName={done.name}
                shareable={studioShareAvailable()}
              />
              <ResultMeta lines={meta} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ease = [0.22, 1, 0.36, 1] as const;

/**
 * Unified entry card: upload and camera are two animated tiles in ONE
 * surface instead of two disconnected cards. The whole card is a drop
 * target (drag-over spotlights the upload tile); tiles stagger in,
 * lift on hover, and compress on tap.
 */
function EntryCard({
  onFiles,
  cameraSupported,
  onCamera,
}: {
  onFiles: (files: File[]) => void;
  cameraSupported: boolean;
  onCamera: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const tiles = (
    <>
      <motion.button
        type="button"
        onClick={() => inputRef.current?.click()}
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease, delay: 0.08 }}
        whileHover={{ y: -3 }}
        whileTap={{ scale: 0.97 }}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        className={`group relative flex flex-1 flex-col items-center gap-2.5 overflow-hidden rounded-2xl border-2 border-dashed px-4 py-7 text-center transition-colors sm:py-9 ${
          over
            ? 'border-brass-400 bg-brass-400/[0.1] shadow-[0_0_0_5px_color-mix(in_srgb,var(--color-brass-400)_16%,transparent)]'
            : 'border-brass-500/35 hover:border-brass-400/60 hover:bg-brass-400/[0.04] dark:border-brass-400/25'
        }`}
      >
        <motion.span
          animate={over ? { scale: 1.1, rotate: -4 } : { scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          className={`flex items-center justify-center rounded-2xl p-3 shadow-sm ring-1 transition-colors ${
            over
              ? 'bg-brass-400 text-white ring-brass-400/40'
              : 'bg-ink-900 text-paper-50 ring-black/5 group-hover:bg-brass-500 dark:bg-paper-100 dark:text-ink-900 dark:ring-white/10'
          }`}
          aria-hidden
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.5-3.5a2 2 0 0 0-3 0L6 20" />
          </svg>
        </motion.span>
        <span>
          <span className="block font-display text-base font-semibold text-ink-900 dark:text-paper-100">
            Upload images
          </span>
          <span className="mt-1 block text-xs text-ink-500 dark:text-ink-300">
            Gallery, screenshots, downloads
          </span>
        </span>
        <AnimatePresence>
          {over && (
            <motion.span
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-[11px] font-semibold uppercase tracking-wider text-brass-600 dark:text-brass-300"
            >
              release to add
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      {cameraSupported && (
        <motion.button
          type="button"
          onClick={onCamera}
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease, delay: 0.16 }}
          whileHover={{ y: -3 }}
          whileTap={{ scale: 0.97 }}
          className="group relative flex flex-1 flex-col items-center gap-2.5 overflow-hidden rounded-2xl border border-brass-500/25 bg-brass-400/[0.07] px-4 py-7 text-center transition-colors hover:border-brass-400/50 hover:bg-brass-400/[0.12] sm:py-9 dark:border-brass-400/20"
        >
          <motion.span
            className="flex items-center justify-center rounded-2xl bg-brass-500 p-3 text-white shadow-sm ring-1 ring-brass-500/30 transition-colors group-hover:bg-brass-400 dark:bg-brass-400 dark:text-ink-900"
            aria-hidden
            whileHover={{ rotate: 6 }}
            transition={{ type: 'spring', stiffness: 400, damping: 15 }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </motion.span>
          <span>
            <span className="block font-display text-base font-semibold text-ink-900 dark:text-paper-100">
              Scan with camera
            </span>
            <span className="mt-1 block text-xs text-ink-500 dark:text-ink-300">
              Auto-crop + enhance on device
            </span>
          </span>
        </motion.button>
      )}
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      className="relative overflow-hidden rounded-2xl border border-paper-300/70 bg-paper-50/85 p-4 shadow-soft sm:p-5 dark:border-ink-700 dark:bg-ink-800/60"
    >
      {/* subtle grid */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05] dark:opacity-[0.07]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, var(--color-brass-500) 1px, transparent 0)',
          backgroundSize: '20px 20px',
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          void onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <p className="relative mb-3 text-center font-display text-lg font-semibold tracking-tight text-ink-900 dark:text-paper-100">
        Add pages
      </p>
      <div className="relative flex flex-col gap-3 sm:flex-row">{tiles}</div>
      <p className="relative mt-3 text-center text-[11px] text-ink-400 dark:text-ink-300">
        100% on-device — files never leave your browser.
      </p>
    </motion.div>
  );
}
