import { useCallback, useEffect, useState, useRef } from 'react';
import {
  ToolHeading,
  DropZone,
  FileChip,
  Button,
  Spinner,
  Card,
  Progress,
  ErrorBlock,
} from '../components/ui';
import { smartOutputName } from '../components/downloadNaming';
import { usePdfFiles } from '../hooks/usePdfFiles';
import ContinueCard from '../components/ContinueCard';
import {
  closeStudioDoc,
  openStudioBytes,
  runStudioOperation,
  consumePendingTransfer,
  getStudioBytes,
  type StudioDoc,
  type StudioOutput,
  type StudioJob,
} from '../services/folio';
import type { DocumentMetadataData, PdfDateData } from '../../types/engine';
import { parseMetadataDate } from '../../utils/parse';

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
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
);

function formatDate(date: PdfDateData): string {
  const pad = (v: number, w = 2): string => String(v).padStart(w, '0');
  const sign = date.tzOffsetMinutes < 0 ? '-' : '+';
  const mag = Math.abs(date.tzOffsetMinutes);
  const zone =
    date.tzOffsetMinutes === 0 ? '+0000' : `${sign}${pad(Math.floor(mag / 60))}${pad(mag % 60)}`;
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)} ${pad(date.hour)}:${pad(date.minute)}:${pad(date.second)} ${zone}`;
}

const TEXT_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'author', label: 'Author' },
  { key: 'subject', label: 'Subject' },
  { key: 'keywords', label: 'Keywords' },
  { key: 'creator', label: 'Creator' },
  { key: 'producer', label: 'Producer' },
] as const;

const DATE_FIELDS = [
  { key: 'creationDate', label: 'Creation date' },
  { key: 'modificationDate', label: 'Modification date' },
] as const;

type TextKey = (typeof TEXT_FIELDS)[number]['key'];
type DateKey = (typeof DATE_FIELDS)[number]['key'];

/**
 * Document properties tool: reads typed metadata through the Folio
 * engine and writes patches (set / clear / leave unchanged) back
 * through it. Minimum UI in the Studio design language — no XMP, no
 * custom keys (both unsupported by the engine, by design).
 */
export default function MetadataTool() {
  const { files, setFiles, addFiles, remove } = usePdfFiles();
  const file = files[0] ?? null;
  const [meta, setMeta] = useState<DocumentMetadataData | null>(null);
  const [reading, setReading] = useState(false);
  const [working, setWorking] = useState(false);
  const [done, setDone] = useState<{
    outputs: StudioOutput[];
    sourceName: string;
    /** Engine `StudioResult.durationMs` — display-only (D4), owned by the card's summary line. */
    durationMs: number;
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [fraction, setFraction] = useState<number | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<TextKey, string>>({
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
  });
  const [clears, setClears] = useState<Record<string, boolean>>({});
  const [dates, setDates] = useState<Record<DateKey, string>>({
    creationDate: '',
    modificationDate: '',
  });
  const jobRef = useRef<StudioJob | null>(null);
  const [continuedFrom, setContinuedFrom] = useState<{
    producedBy: string;
    sourceName: string;
  } | null>(null);
  // Pending-transfer claim: same back-out-release discipline as
  // MergeTool/RearrangeTool (single doc here — extras are ignored, never
  // uploaded, never in state).
  const claimedRef = useRef<StudioDoc[]>([]);
  const ranRef = useRef(false);
  const mountGenRef = useRef(0);

  // Pending-transfer intake (mount once): the handed-off doc becomes the
  // single input by reference — verified live, never re-uploaded.
  useEffect(() => {
    mountGenRef.current += 1;
    const gen = mountGenRef.current;
    const pending = consumePendingTransfer();
    if (pending !== null) {
      const live = pending.docs.filter((d) => getStudioBytes(d.id) !== undefined);
      const firstDoc: StudioDoc | undefined = live.length > 0 ? live[0] : undefined;
      if (firstDoc !== undefined) {
        claimedRef.current = [firstDoc];
        setFiles((prev) => (prev.length > 0 ? prev : [firstDoc]));
        setContinuedFrom({ producedBy: pending.producedBy, sourceName: pending.sourceName });
      }
    }
    return () => {
      // Same deferred back-out release as MergeTool (P5-1 via closeStudioDoc).
      const claimed = claimedRef.current;
      window.setTimeout(() => {
        if (mountGenRef.current !== gen) return;
        claimedRef.current = claimedRef.current.filter((d) => !claimed.some((c) => c.id === d.id));
        if (ranRef.current) return;
        for (const d of claimed) void closeStudioDoc(d.id);
      }, 0);
    };
  }, [setFiles]);

  // Cancel the running job when the user navigates away.
  useEffect(
    () => () => {
      void jobRef.current?.cancel();
    },
    [],
  );

  useEffect(() => {
    setMeta(null);
    setDone(null);
    setError(null);
    if (!file) return;
    let cancelled = false;
    (async () => {
      setReading(true);
      try {
        const job = runStudioOperation('pdf.read_metadata', [file.id], {});
        jobRef.current = job;
        const out = await job.done;
        jobRef.current = null;
        if (cancelled) return;
        const summary = out.summary;
        if (summary && 'metadata' in summary && !('pdfVersion' in summary)) {
          setMeta(summary.metadata);
        }
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setReading(false);
      }
    })();
    return () => {
      cancelled = true;
      void jobRef.current?.cancel();
    };
  }, [file]);

  const onSave = async () => {
    if (!file) return;
    ranRef.current = true;
    setWorking(true);
    setError(null);
    setDone(null);
    setFraction(null);
    setStage(null);
    try {
      // The engine rejects setting "" (L3) — a field with only blank
      // input and no Clear tick is almost certainly a removal attempt,
      // so reject it here with Clear guidance instead of silently
      // leaving it unchanged. Untouched fields stay "" and are skipped
      // below (leave-unchanged patch semantics, OPERATIONS.md).
      for (const { key, label } of TEXT_FIELDS) {
        if (!clears[key] && texts[key] !== '' && texts[key].trim() === '') {
          throw new Error(`"${label}" is blank — tick Clear to remove it, or leave it unchanged.`);
        }
      }
      for (const { key, label } of DATE_FIELDS) {
        if (!clears[key] && dates[key] !== '' && dates[key].trim() === '') {
          throw new Error(`"${label}" is blank — tick Clear to remove it, or leave it unchanged.`);
        }
      }
      const patch: Record<string, { op: 'set' | 'clear'; value?: unknown }> = {};
      for (const { key } of TEXT_FIELDS) {
        if (clears[key]) {
          patch[key] = { op: 'clear' };
        } else if (texts[key].trim() !== '') {
          patch[key] = { op: 'set', value: texts[key].trim() };
        }
      }
      for (const { key } of DATE_FIELDS) {
        const wireKey = key === 'creationDate' ? 'creation_date' : 'modification_date';
        if (clears[key]) {
          patch[wireKey] = { op: 'clear' };
        } else if (dates[key].trim() !== '') {
          const parsed = parseMetadataDate(dates[key]);
          if (!parsed.ok)
            throw new Error(
              `${key === 'creationDate' ? 'Creation date' : 'Modification date'}: ${parsed.error}`,
            );
          const d = parsed.date;
          patch[wireKey] = {
            op: 'set',
            value: {
              year: d.year,
              month: d.month,
              day: d.day,
              hour: d.hour,
              minute: d.minute,
              second: d.second,
              tz_offset_minutes: d.tzOffsetMinutes,
            },
          };
        }
      }
      const job = runStudioOperation(
        'pdf.set_metadata',
        [file.id],
        { patch },
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
      if (first === undefined) throw new Error('Metadata produced no output.');
      const name = smartOutputName('metadata', [file.name]);
      setDone({
        sourceName: file.name,
        outputs: [{ ...first, name }],
        durationMs: out.durationMs,
      });
      // Refresh the displayed properties from the written output.
      const temp = await openStudioBytes(`reread:${name}`, first.bytes);
      try {
        const reread = await runStudioOperation('pdf.read_metadata', [temp.id], {}).done;
        const summary = reread.summary;
        if (summary && 'metadata' in summary && !('pdfVersion' in summary)) {
          setMeta(summary.metadata);
        }
      } finally {
        await closeStudioDoc(temp.id);
      }
    } catch (e) {
      jobRef.current = null;
      const code = (e as { code?: string }).code;
      if (code === 'CANCELLED') {
        setError(new Error('Metadata save cancelled.'));
      } else {
        setError(e);
      }
    } finally {
      setWorking(false);
      setFraction(null);
      setStage(null);
    }
  };

  const onCancel = async () => {
    try {
      await jobRef.current?.cancel();
    } catch {
      // The job settles the UI via onSave's catch/finally.
    }
  };

  const handleBackToEdit = useCallback(() => {
    setDone(null);
  }, []);

  const rows: Array<[string, string]> = meta
    ? [
        ['Title', meta.title ?? '—'],
        ['Author', meta.author ?? '—'],
        ['Subject', meta.subject ?? '—'],
        ['Keywords', meta.keywords ?? '—'],
        ['Creator', meta.creator ?? '—'],
        ['Producer', meta.producer ?? '—'],
        ['Creation date', meta.creationDate === null ? '—' : formatDate(meta.creationDate)],
        [
          'Modification date',
          meta.modificationDate === null ? '—' : formatDate(meta.modificationDate),
        ],
      ]
    : [];

  return (
    <div className="py-6">
      <ToolHeading
        icon={ICON}
        name="Metadata"
        desc="Read and edit document properties — title, author, dates and more."
      />

      {!file && (
        <DropZone
          accept="application/pdf"
          multiple={false}
          onFiles={(f) => addFiles(f)}
          title="Drop a PDF to inspect"
          cta="Select PDF"
        />
      )}

      {file && (
        <div className="space-y-5">
          {continuedFrom && (
            <p className="text-xs text-brass-600 dark:text-brass-300 bg-brass-400/[0.07] rounded-xl px-4 py-2.5 border border-brass-500/25">
              Continued from{' '}
              {continuedFrom.producedBy.charAt(0).toUpperCase() + continuedFrom.producedBy.slice(1)}{' '}
              — {continuedFrom.sourceName} is loaded below by reference (not re-uploaded).
            </p>
          )}
          <FileChip
            name={file.name}
            size={file.sizeBytes}
            onRemove={() => {
              // P5-1 class: removal goes through `remove` (frees bytes,
              // the rendering document, and URLs) — never a bare state reset.
              claimedRef.current = claimedRef.current.filter((d) => d.id !== file.id);
              remove(file.id);
              setDone(null);
              setMeta(null);
            }}
          />

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-3">
              Current properties
            </p>
            {reading ? (
              <div className="flex items-center gap-2 text-sm text-ink-400">
                <Spinner /> Reading…
              </div>
            ) : meta ? (
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                {rows.map(([label, value]) => (
                  <div
                    key={label}
                    className="flex justify-between gap-2 border-b border-paper-200/60 dark:border-ink-800/60 py-1"
                  >
                    <dt className="text-ink-400 dark:text-ink-300 shrink-0">{label}</dt>
                    <dd
                      className="truncate text-right text-ink-900 dark:text-paper-100"
                      title={value}
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-ink-400">No metadata yet.</p>
            )}
          </Card>

          <Card>
            <p className="text-sm font-medium text-ink-700 dark:text-paper-100 mb-1">
              Edit properties
            </p>
            <p className="text-xs text-ink-400 dark:text-ink-300 mb-3">
              Blank means leave unchanged. To remove a value, tick Clear — empty values can’t be
              saved. Dates use <span className="font-mono">YYYY-MM-DD HH:MM:SS +HHMM</span>.
            </p>
            <div className="space-y-2">
              {TEXT_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor={`studio-meta-${key}`}
                      className="mb-1 block text-xs text-ink-400 dark:text-ink-300"
                    >
                      {label}
                    </label>
                    <input
                      id={`studio-meta-${key}`}
                      className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2 min-h-[44px] text-sm text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
                      value={texts[key]}
                      onChange={(e) => setTexts((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </div>
                  <label className="flex shrink-0 items-center gap-1.5 min-h-[44px] px-2 text-xs text-ink-400 dark:text-ink-300">
                    <input
                      type="checkbox"
                      checked={!!clears[key]}
                      onChange={(e) => setClears((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    Clear
                  </label>
                </div>
              ))}
              {DATE_FIELDS.map(({ key, label }) => (
                <div key={key} className="flex items-end gap-2">
                  <div className="flex-1">
                    <label
                      htmlFor={`studio-meta-${key}`}
                      className="mb-1 block text-xs text-ink-400 dark:text-ink-300"
                    >
                      {label}
                    </label>
                    <input
                      id={`studio-meta-${key}`}
                      className="w-full rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-4 py-2 min-h-[44px] text-sm font-mono text-ink-900 dark:text-paper-100 outline-none focus:border-brass-400"
                      value={dates[key]}
                      placeholder="2026-01-23 09:30:00 +0530"
                      onChange={(e) => setDates((p) => ({ ...p, [key]: e.target.value }))}
                    />
                  </div>
                  <label className="flex shrink-0 items-center gap-1.5 min-h-[44px] px-2 text-xs text-ink-400 dark:text-ink-300">
                    <input
                      type="checkbox"
                      checked={!!clears[key]}
                      onChange={(e) => setClears((p) => ({ ...p, [key]: e.target.checked }))}
                    />
                    Clear
                  </label>
                </div>
              ))}
            </div>
          </Card>

          {!done && (
            <div className="flex items-center gap-3">
              <Button onClick={onSave} disabled={working || reading} className="w-full">
                {working ? 'Saving…' : 'Save metadata'}
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
            <ContinueCard
              outputs={done.outputs}
              sourceName={done.sourceName}
              producedBy="metadata"
              onBackToEdit={handleBackToEdit}
              durationMs={done.durationMs}
            />
          )}
        </div>
      )}
    </div>
  );
}
