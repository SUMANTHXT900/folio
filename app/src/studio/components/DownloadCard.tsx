/**
 * Naming-first download cards (feature-wide).
 *
 * Tools used to auto-download with an inline-invented filename the moment
 * a job finished. Now every completion renders a `DownloadCard` instead:
 * a Smart / Custom toggle, an editable filename, and a Download anchor
 * whose `download` attribute always carries the exact final name — the
 * download triggers with what the user sees, never a generic fallback.
 * After the first save, the familiar `DoneBanner` takes over (re-save +
 * share with the same exact name).
 *
 * - Smart: input pre-filled from the input file names (`downloadNaming`),
 *   with a one-tap reset to the suggestion.
 * - Custom: blank slate with a placeholder; `.pdf` is appended
 *   automatically and illegal characters are sanitized on the way out.
 *
 * `MultiDownloadCard` is the split multi-part equivalent: one editable
 * row per part plus a Download-all button.
 */
import { useEffect, useRef, useState } from 'react';
import { sanitizeFileName } from './downloadNaming';
import { studioShare } from '../services/folio';
import { DoneBanner } from './ui';

const CUSTOM_PLACEHOLDER = 'my-document';

function useObjectUrl(blob: Blob): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [blob]);
  return url;
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'smart' | 'custom';
  onChange: (mode: 'smart' | 'custom') => void;
}) {
  const btn = (value: 'smart' | 'custom', label: string) => (
    <button
      key={value}
      type="button"
      aria-label={`${label} name`}
      aria-pressed={mode === value}
      onClick={() => onChange(value)}
      className={
        'rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors min-h-[36px] ' +
        (mode === value
          ? 'bg-brass-400 text-ink-900 shadow-sm'
          : 'text-ink-500 dark:text-ink-300 hover:bg-brass-400/15')
      }
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Naming mode"
      className="inline-flex items-center gap-1 rounded-xl border border-paper-300 dark:border-ink-700 bg-paper-100 dark:bg-ink-900 p-1"
    >
      {btn('smart', 'Smart')}
      {btn('custom', 'Custom')}
    </div>
  );
}

export function DownloadCard({
  blob,
  suggestedName,
  shareable = false,
  title = 'Name your PDF',
}: {
  /** Completed output bytes. */
  blob: Blob;
  /** Smart default from the input names (`downloadNaming.smartOutputName`). */
  suggestedName: string;
  /** Whether the Web Share path is available on this device. */
  shareable?: boolean;
  /** Card heading. */
  title?: string;
}) {
  const [mode, setMode] = useState<'smart' | 'custom'>('smart');
  const [text, setText] = useState(suggestedName);
  const [downloaded, setDownloaded] = useState(false);
  const [shared, setShared] = useState(false);
  const url = useObjectUrl(blob);

  // A new completion (new blob/suggestion) resets the card.
  useEffect(() => {
    setMode('smart');
    setText(suggestedName);
    setDownloaded(false);
    setShared(false);
  }, [blob, suggestedName]);

  const finalName = sanitizeFileName(text.trim() === '' ? suggestedName : text, suggestedName);

  if (downloaded) {
    return <DoneBanner name={finalName} blob={blob} shareable={shareable} />;
  }

  return (
    <div className="mt-5 rounded-xl border border-brass-400/40 bg-brass-400/[0.07] px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink-700 dark:text-paper-100">{title}</p>
        <ModeToggle
          mode={mode}
          onChange={(next) => {
            setMode(next);
            setText(next === 'smart' ? suggestedName : '');
          }}
        />
      </div>
      <p className="mt-1 text-xs text-ink-400 dark:text-ink-300">
        {mode === 'smart'
          ? 'Based on your file names — tweak it or switch to Custom.'
          : 'Your own name — “.pdf” is added automatically.'}
      </p>
      <input
        type="text"
        aria-label="File name"
        value={text}
        placeholder={mode === 'custom' ? CUSTOM_PLACEHOLDER : suggestedName}
        onChange={(e) => setText(e.target.value)}
        maxLength={120}
        autoComplete="off"
        spellCheck={false}
        className="mt-2.5 w-full rounded-lg border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900 px-3 py-2.5 font-mono text-sm text-ink-700 dark:text-paper-100 placeholder:text-ink-400/60 focus:outline-none focus:border-brass-400 min-h-[44px]"
      />
      <p className="mt-1.5 truncate font-mono text-[11px] text-ink-400 dark:text-ink-300">
        Saves as: <span className="font-semibold">{finalName}</span>
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {url && (
          <a
            href={url}
            download={finalName}
            aria-label="Download PDF"
            onClick={() => setDownloaded(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-forest-600 hover:bg-forest-500 text-white px-4 py-2.5 text-sm font-semibold shadow-sm transition-colors min-h-[44px]"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" x2="12" y1="15" y2="3" />
            </svg>
            Download
          </a>
        )}
        {shareable && (
          <button
            type="button"
            onClick={async () => {
              const r = await studioShare(blob, finalName);
              if (r === 'shared') setShared(true);
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-forest-500/40 text-forest-600 dark:text-forest-300 px-4 py-2.5 text-sm font-medium hover:bg-forest-500/[0.08] transition-colors min-h-[44px]"
          >
            {shared ? 'Shared ✓' : 'Share…'}
          </button>
        )}
      </div>
    </div>
  );
}

export interface DownloadPart {
  /** Stable row key (part index is fine). */
  key: string;
  blob: Blob;
  suggestedName: string;
}

function PartRow({
  part,
  index,
  shareable,
  anchorRef,
}: {
  part: DownloadPart;
  index: number;
  shareable: boolean;
  anchorRef: (el: HTMLAnchorElement | null) => void;
}) {
  const [text, setText] = useState(part.suggestedName);
  const url = useObjectUrl(part.blob);
  const finalName = sanitizeFileName(
    text.trim() === '' ? part.suggestedName : text,
    part.suggestedName,
  );
  return (
    <div className="rounded-lg border border-paper-300 dark:border-ink-700 bg-paper-50 dark:bg-ink-900/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          aria-label={`File name part ${index + 1}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={120}
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-paper-300 dark:border-ink-700 bg-paper-100 dark:bg-ink-900 px-2.5 py-2 font-mono text-[13px] text-ink-700 dark:text-paper-100 focus:outline-none focus:border-brass-400 min-h-[40px]"
        />
        {url && (
          <a
            ref={anchorRef}
            href={url}
            download={finalName}
            aria-label={`Download part ${index + 1}`}
            data-download-part={index}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-forest-600 hover:bg-forest-500 text-white px-3 py-2 text-[13px] font-semibold transition-colors min-h-[40px]"
          >
            Save
          </a>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="truncate font-mono text-[11px] text-ink-400 dark:text-ink-300">
          Saves as: <span className="font-semibold">{finalName}</span>
        </p>
        {shareable && <PartShare blob={part.blob} finalName={finalName} index={index} />}
      </div>
    </div>
  );
}

function PartShare({ blob, finalName, index }: { blob: Blob; finalName: string; index: number }) {
  const [shared, setShared] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Share part ${index + 1}`}
      onClick={async () => {
        const r = await studioShare(blob, finalName);
        if (r === 'shared') setShared(true);
      }}
      className="shrink-0 text-xs font-medium text-forest-600 dark:text-forest-300 hover:underline min-h-[32px]"
    >
      {shared ? 'Shared ✓' : 'Share…'}
    </button>
  );
}

export function MultiDownloadCard({
  parts,
  shareable = false,
  title = 'Name your PDFs',
}: {
  parts: DownloadPart[];
  shareable?: boolean;
  title?: string;
}) {
  const anchorsRef = useRef<Array<HTMLAnchorElement | null>>([]);
  const [savedAll, setSavedAll] = useState(false);

  const downloadAll = async () => {
    for (const anchor of anchorsRef.current) {
      anchor?.click();
      await new Promise((r) => setTimeout(r, 400));
    }
    setSavedAll(true);
  };

  return (
    <div className="mt-5 rounded-xl border border-brass-400/40 bg-brass-400/[0.07] px-4 py-3.5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink-700 dark:text-paper-100">{title}</p>
        <button
          type="button"
          onClick={() => void downloadAll()}
          aria-label="Download all parts"
          className="inline-flex items-center gap-2 rounded-lg bg-forest-600 hover:bg-forest-500 text-white px-4 py-2 text-sm font-semibold shadow-sm transition-colors min-h-[44px]"
        >
          Download all ({parts.length})
        </button>
      </div>
      <p className="mt-1 text-xs text-ink-400 dark:text-ink-300">
        Smart names from your file and page ranges — edit any row before saving.
      </p>
      <div className="mt-2.5 space-y-2">
        {parts.map((part, i) => (
          <PartRow
            key={part.key}
            part={part}
            index={i}
            shareable={shareable}
            anchorRef={(el) => {
              anchorsRef.current[i] = el;
            }}
          />
        ))}
      </div>
      {savedAll && (
        <p className="mt-2 text-xs text-forest-600 dark:text-forest-300" role="status">
          All parts saved — tap any row’s Save again if one didn’t come through.
        </p>
      )}
    </div>
  );
}
