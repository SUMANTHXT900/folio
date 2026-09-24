import { useRef, useState } from 'react';
import {
  ToolHeading,
  DropZone,
  Button,
  Card,
  DoneBanner,
  Progress,
  ResultMeta,
  ErrorBlock,
  formatBytes,
} from '../components/ui';
import {
  releaseStagedBytes,
  runStudioOperation,
  formatDurationMs,
  stageStudioBytes,
  studioDownload,
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
  const { pages, addFiles, addEntries, move, moveTo, remove, rotate, clear } = useImagePages();
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
  const jobRef = useRef<StudioJob | null>(null);
  const moreInputRef = useRef<HTMLInputElement>(null);
  const [cameraSupported] = useState(
    () =>
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function',
  );

  const addUploads = (incoming: File[]) => {
    const result = addFiles(incoming, 'upload');
    if (result.skipped > 0) {
      setError(new Error('Skipped non-image file(s) — JPEG and PNG only.'));
    } else {
      setError(null);
    }
  };

  const onCapture = (file: File) => {
    const [id] = addEntries([{ file, name: file.name, source: 'camera' }]);
    if (id !== undefined) setSessionIds((prev) => [...prev, id]);
  };

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
      const name = 'images.pdf';
      // ONE Blob for auto-download, re-download, and share (P2): the
      // engine output bytes are not retained afterwards, and no second
      // Blob is built. DoneBanner owns its object URL (revoked on
      // replace/unmount); the auto-download URL revokes after 60s.
      // The Blob stays only while this completion card is displayed —
      // required for save-again/share; cleared on rebuild, clear, unmount.
      const blob = new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' });
      studioDownload(blob, name);
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
          <DropZone
            accept={ACCEPT}
            multiple
            onFiles={addUploads}
            title="Drop your images here"
            cta="Select images"
          />
          {cameraSupported && (
            <Button
              variant="ghost"
              onClick={() => {
                setSessionIds([]);
                setCameraMode(true);
              }}
              className="w-full"
            >
              <svg
                width="16"
                height="16"
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
              Scan with camera
            </Button>
          )}
          {error !== null && <ErrorBlock error={error} />}
        </div>
      ) : (
        <div className="space-y-5">
          {cameraMode ? (
            <CameraCapture
              onCapture={onCapture}
              onScanAccept={onScanAccept}
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
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                {pages.length} page{pages.length === 1 ? '' : 's'} · top-to-bottom is PDF order
              </p>
              <button
                onClick={onClearAll}
                className="rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-ink-300 dark:hover:bg-red-950/30"
              >
                Clear all
              </button>
            </div>
            {pages.length > 0 ? (
              <PageGrid
                pages={pages}
                onMove={move}
                onMoveTo={moveTo}
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
                  addUploads(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <Button variant="ghost" onClick={() => moreInputRef.current?.click()}>
                Add images
              </Button>
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
              <DoneBanner name={done.name} blob={done.blob} shareable={studioShareAvailable()} />
              <ResultMeta lines={meta} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
