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

interface ImagePick {
  id: number;
  name: string;
  size: number;
  file: File;
}

/**
 * Images → PDF tool: builds one PDF from JPEG/PNG images through the
 * Folio engine (`pdf.images_to_pdf`, one page per image, in listed
 * order). Image bytes are staged in the service store only for the run
 * (never in React state); the picker keeps name/size/file handles.
 */
export default function ImagesTool() {
  const [picks, setPicks] = useState<ImagePick[]>([]);
  const [pageSize, setPageSize] = useState<'fit' | 'standard'>('fit');
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{ name: string; blob: Blob } | null>(null);
  const [meta, setMeta] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const idRef = useRef(0);
  const jobRef = useRef<StudioJob | null>(null);

  const addImages = (incoming: File[]) => {
    const images = incoming.filter(
      (f) => f.type === 'image/jpeg' || f.type === 'image/png' || /\.(jpe?g|png)$/i.test(f.name),
    );
    if (images.length < incoming.length) {
      setError(new Error('Skipped non-image file(s) — JPEG and PNG only.'));
    } else {
      setError(null);
    }
    if (images.length === 0) return;
    setPicks((prev) => [
      ...prev,
      ...images.map((file) => {
        idRef.current += 1;
        return { id: idRef.current, name: file.name, size: file.size, file };
      }),
    ]);
  };

  const onBuild = async () => {
    if (picks.length === 0) return;
    setWorking(true);
    setError(null);
    setDone(null);
    setMeta([]);
    setFraction(null);
    setStage(null);
    const staged: string[] = [];
    try {
      for (const pick of picks) {
        const buffer = await pick.file.arrayBuffer();
        staged.push(stageStudioBytes(pick.name, new Uint8Array(buffer)));
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
      studioDownload(first.bytes, name);
      setDone({
        name,
        blob: new Blob([first.bytes as unknown as BlobPart], { type: 'application/pdf' }),
      });
      const summary = out.summary;
      const imageCount =
        summary !== undefined && 'imageCount' in summary && typeof summary.imageCount === 'number'
          ? summary.imageCount
          : picks.length;
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
        desc="Build one PDF from JPEG or PNG images, one page per image, in listed order."
      />

      {picks.length === 0 ? (
        <DropZone
          accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          multiple
          onFiles={addImages}
          title="Drop your images here"
          cta="Select images"
        />
      ) : (
        <div className="space-y-5">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-ink-700 dark:text-paper-100">
                {picks.length} image{picks.length > 1 ? 's' : ''} · page order is list order
              </p>
              <button
                onClick={() => setPicks([])}
                className="rounded-lg px-2 py-1 text-xs text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-ink-300 dark:hover:bg-red-950/30"
              >
                Clear all
              </button>
            </div>
            <ul className="mb-4 flex flex-col gap-2">
              {picks.map((pick, i) => (
                <li
                  key={pick.id}
                  className="flex items-center gap-3 rounded-xl border border-paper-300 bg-paper-50 px-3 py-2 dark:border-ink-700 dark:bg-ink-800"
                >
                  <span className="w-6 shrink-0 font-mono text-sm text-brass-600 tabular-nums dark:text-brass-300">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink-900 dark:text-paper-100">
                      {pick.name}
                    </p>
                  </div>
                  <button
                    onClick={() => setPicks((prev) => prev.filter((p) => p.id !== pick.id))}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"
                    aria-label={`Remove ${pick.name}`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mb-3 text-sm font-medium text-ink-700 dark:text-paper-100">
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

          {!done && (
            <div className="flex items-center gap-3">
              <Button onClick={onBuild} disabled={working} className="w-full">
                {working
                  ? 'Building…'
                  : `Build PDF · ${picks.length} image${picks.length === 1 ? '' : 's'}`}
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
