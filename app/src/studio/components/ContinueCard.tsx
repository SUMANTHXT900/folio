/**
 * ContinueCard — the post-completion "what's next" card.
 *
 * After a tool finishes, the user either downloads the output(s) or
 * continues working with them in another tool. This card owns that fork:
 *
 * - Summary line first: engine duration + page counts + output size. Every
 *   value is a prop carried from the `StudioResult` (output `pageCount` /
 *   `byteLength`, `durationMs`) — displayed, never computed (D4).
 * - "Use in another tool" opens a filtered tool picker. Targets are
 *   `merge | split | rearrange | rotate | metadata` only — `images` is
 *   NEVER a v1 target, though `images` IS a valid `producedBy`. Tool
 *   names/taglines mirror `TOOL_LIST` in `StudioApp.tsx` (duplicated, not
 *   imported — importing `StudioApp` would drag `Home`/`About` into every
 *   tool chunk).
 * - "Download" renders the existing `DownloadCard` (single output) or
 *   `MultiDownloadCard` (multi output) with sourceName-chained naming:
 *   single outputs take `smartOutputName(producedBy-kind, [sourceName])`
 *   when the producer maps to a smart-name kind, else the sanitized engine
 *   output name; split parts fall back to
 *   `smartSplitPartName(sourceName, i+1, i+1)` per row.
 * - Split multi-output continues per part ("Continue with this part") or
 *   as a whole ("Continue with all N as merge inputs"). A multi-file
 *   subset can only continue into Merge, so the other targets disable with
 *   a visible reason while it is selected.
 *
 * Service seam (frozen contract): on target pick the card calls
 * `adoptOutputsAsDocs(outputs subset, sourceName)`, then
 * `setPendingTransfer(docs, sourceName, producedBy)`, then navigates via
 * `window.location.hash = '#/' + target`. Both live in
 * `services/folio.ts` (zero-copy pending transfer, D5); the card imports
 * them statically and tests mock them at the module boundary. Adopt
 * failures surface honestly in an `ErrorBlock` (friendly message + code,
 * never "something went wrong" alone).
 *
 * Motion (G-UX-RESEARCH, exact): the open branch renders as a keyed
 * `motion.div` under `AnimatePresence mode="wait"` — step transitions run
 * initial {opacity: 0, x: 16} → animate {1, 0} → exit {0, -16} at duration
 * 0.26 / ease [0.22, 1, 0.36, 1] (shared tokens in `./ui`, also unit-tested
 * here). Picker rows tween in (duration 0.22, stagger capped at 0.16s) —
 * never springs; springs live only on `Button` hover/tap. `useReducedMotion`
 * collapses everything to a duration-0.01 opacity crossfade with no stagger
 * and static (unanimated) labels. No portals anywhere in this card (a
 * portal must never sit inside `AnimatePresence`), and `Progress` scaleX is
 * untouched. The adopting-status line keeps a reserved min-h slot sized to
 * the tallest status state (two wrapped lines at 360px) so the async
 * announcement never shifts layout.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Button,
  Card,
  CONTINUE_EASE,
  CONTINUE_REDUCED_DURATION,
  CONTINUE_ROW_DURATION,
  CONTINUE_STEP_DURATION,
  CONTINUE_STEP_X,
  ErrorBlock,
  ResultMeta,
  continueStaggerDelay,
  formatBytes,
} from './ui';
import { DownloadCard, MultiDownloadCard, type DownloadPart } from './DownloadCard';
import {
  sanitizeFileName,
  smartOutputName,
  smartSplitPartName,
  stripPdfExt,
  type SmartNameKind,
} from './downloadNaming';
import {
  adoptOutputsAsDocs,
  formatDurationMs,
  setPendingTransfer,
  studioShareAvailable,
} from '../services/folio';
import type { StudioOutput } from '../services/folio';

export interface ContinueCardProps {
  /** Completed engine outputs (page counts + sizes displayed, never computed). */
  outputs: StudioOutput[];
  /** Input name the outputs derive from (drives chained download names). */
  sourceName: string;
  /** Producing tool id (`merge | split | rearrange | rotate | metadata | images`). */
  producedBy: string;
  /** Returns to the tool's edit state (re-run / adjust inputs). */
  onBackToEdit: () => void;
  /**
   * Engine duration from `StudioResult.durationMs` — displayed only (D4).
   * Additive optional: the frozen contract lists the four props above;
   * the required summary line needs the duration from somewhere, and this
   * keeps it a display-only prop instead of UI computation.
   */
  durationMs?: number;
}

/** v1 continuation targets: images is NEVER a target (valid producer only). */
export type ContinueTarget = 'merge' | 'split' | 'rearrange' | 'rotate' | 'metadata';

const CONTINUE_TARGETS: ReadonlyArray<{ id: ContinueTarget; name: string; tagline: string }> = [
  { id: 'merge', name: 'Merge', tagline: 'Combine with other PDFs' },
  { id: 'split', name: 'Split', tagline: 'Extract pages or break apart' },
  { id: 'rearrange', name: 'Rearrange', tagline: 'Reorder pages' },
  { id: 'rotate', name: 'Rotate', tagline: 'Fix page orientation' },
  { id: 'metadata', name: 'Metadata', tagline: 'Read and edit properties' },
];

const PRODUCER_NAME: Record<string, string> = {
  merge: 'Merge',
  split: 'Split',
  rearrange: 'Rearrange',
  rotate: 'Rotate',
  metadata: 'Metadata',
  images: 'Images',
};

/** Producers with a smart-name kind reuse the download-naming policy. */
const SMART_KIND: Record<string, SmartNameKind> = {
  merge: 'merge',
  rearrange: 'rearrange',
  rotate: 'rotate',
  metadata: 'metadata',
  images: 'images',
};

const EASE: [number, number, number, number] = CONTINUE_EASE;

/** Step-transition builder (pure, unit-tested): G tokens exact, reduced-motion collapses to a 0.01 crossfade. */
export function continueStepTransition(reducedMotion: boolean): {
  duration: number;
  ease: [number, number, number, number];
} {
  return {
    duration: reducedMotion ? CONTINUE_REDUCED_DURATION : CONTINUE_STEP_DURATION,
    ease: CONTINUE_EASE,
  };
}

/** Picker-row delay builder (pure, unit-tested): capped stagger, zero under reduced motion. */
export function continueRowDelay(index: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : continueStaggerDelay(index);
}

/* ---------- summary + naming (display only, never computed) ---------- */

function summaryLines(
  outputs: StudioOutput[],
  durationMs: number | undefined,
): Array<string | null | undefined | false> {
  const duration = durationMs !== undefined ? `Completed in ${formatDurationMs(durationMs)}` : null;
  if (outputs.length === 1) {
    const out = outputs[0];
    return [
      out.pageCount !== null && out.pageCount !== undefined
        ? `${out.pageCount} page${out.pageCount === 1 ? '' : 's'}`
        : null,
      formatBytes(out.byteLength),
      duration,
    ];
  }
  return [
    `${outputs.length} files`,
    ...outputs.map((out, i) =>
      out.pageCount !== null && out.pageCount !== undefined
        ? `Part ${i + 1} — ${out.pageCount} pages`
        : `Part ${i + 1}`,
    ),
    duration,
  ];
}

function singleSuggestion(producedBy: string, sourceName: string, outputName: string): string {
  const kind = SMART_KIND[producedBy];
  if (kind !== undefined) {
    if (kind === 'merge') {
      // Idempotent merge naming: continuing from `a-b-merged.pdf` must
      // yield `a-b-merged.pdf`, never `a-b-merged-merged.pdf` — strip our
      // own suffix before the smart-name policy re-applies it. Other
      // producers' suffixes chain exactly (`report-merged-rearranged.pdf`
      // is correct), matching the rearrange-exact + images-idempotent
      // reference behaviors.
      const base = stripPdfExt(sourceName.trim());
      const unstamped = base.replace(/-merged$/i, '');
      return smartOutputName(kind, [unstamped === '' ? sourceName : unstamped]);
    }
    return smartOutputName(kind, [sourceName]);
  }
  const raw = outputName.trim() !== '' ? outputName : sourceName;
  return sanitizeFileName(raw, sourceName);
}

function partLabel(output: StudioOutput, index: number): string {
  return output.name.trim() !== '' ? output.name : `Part ${index + 1}`;
}

export function ContinueCard({
  outputs,
  sourceName,
  producedBy,
  onBackToEdit,
  durationMs,
}: ContinueCardProps) {
  const [branch, setBranch] = useState<'choose' | 'use' | 'download'>('choose');
  // Multi-output subset: null = all parts; otherwise the picked indices.
  const [picked, setPicked] = useState<number[] | null>(null);
  const [adopting, setAdopting] = useState<ContinueTarget | null>(null);
  const [adoptError, setAdoptError] = useState<unknown>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [shareable] = useState<boolean>(() => {
    try {
      return studioShareAvailable();
    } catch {
      return false;
    }
  });
  const reduceMotion = useReducedMotion() ?? false;

  const headingRef = useRef<HTMLHeadingElement>(null);
  const useTriggerRef = useRef<HTMLButtonElement>(null);
  const downloadTriggerRef = useRef<HTMLButtonElement>(null);
  // Esc-collapse target: set by the key handler before collapsing so the
  // post-collapse effect can return focus to the trigger that opened the
  // branch (instead of the heading, which owns step-open focus).
  const focusAfterCollapse = useRef<HTMLButtonElement | null>(null);

  // Mount: keyboard users land on the heading (asserted in tests).
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // Step change: opening a branch moves focus to the heading so screen
  // readers announce the new step. Collapsing via its own toggle leaves
  // focus where it is (the pressed trigger); collapsing via Esc returns
  // focus to the trigger that opened the branch (see below).
  useEffect(() => {
    if (branch === 'choose') {
      if (focusAfterCollapse.current !== null) {
        focusAfterCollapse.current.focus();
        focusAfterCollapse.current = null;
      }
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
  }, [branch]);

  // Esc collapses the open branch and returns focus to its trigger.
  useEffect(() => {
    if (branch === 'choose') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      focusAfterCollapse.current =
        branch === 'use' ? useTriggerRef.current : downloadTriggerRef.current;
      setBranch('choose');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [branch]);

  // A new completion (new outputs identity) resets the picked subset and
  // any prior adopt error in one pass — a stale part index must never
  // point at a different file after a re-run. The open branch stays put
  // (DownloadCard resets itself internally; the picker re-derives).
  useEffect(() => {
    setPicked(null);
    setAdoptError(null);
  }, [outputs]);

  const blobs = useMemo(
    () =>
      outputs.map(
        (out) => new Blob([out.bytes as unknown as BlobPart], { type: 'application/pdf' }),
      ),
    [outputs],
  );

  const parts: DownloadPart[] = useMemo(
    () =>
      outputs.map((out, i) => ({
        key: `${i}-${out.byteLength}`,
        blob: blobs[i],
        suggestedName:
          out.name.trim() !== ''
            ? sanitizeFileName(out.name, sourceName)
            : smartSplitPartName(sourceName, i + 1, i + 1),
      })),
    [outputs, blobs, sourceName],
  );

  const meta = useMemo(() => summaryLines(outputs, durationMs), [outputs, durationMs]);
  const producer = PRODUCER_NAME[producedBy] ?? producedBy;

  if (outputs.length === 0) {
    return (
      <Card className="mt-5">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-lg font-semibold tracking-tight text-ink-900 focus:outline-none dark:text-paper-100"
        >
          No output to continue with
        </h2>
        <p className="mt-1 text-sm text-ink-500 dark:text-ink-300">
          The operation finished without producing a file.
        </p>
        <div className="mt-4">
          <Button variant="ghost" onClick={onBackToEdit} className="min-h-[44px]">
            Back to edit
          </Button>
        </div>
      </Card>
    );
  }

  const isMulti = outputs.length > 1;
  const allIndices = outputs.map((_, i) => i);
  const subset: number[] = !isMulti ? [0] : (picked ?? allIndices);
  const chosen: StudioOutput[] = subset
    .map((i) => outputs[i])
    .filter((out): out is StudioOutput => out !== undefined);
  // A multi-file subset only makes sense as merge inputs.
  const mergeOnly = isMulti && subset.length > 1;
  const subsetLabel =
    subset.length === 1 && isMulti
      ? `Part ${subset[0] + 1}`
      : `${subset.length} file${subset.length === 1 ? '' : 's'}`;
  // Status detail: multi-file subsets name themselves; a single output
  // needs no qualifier ("Preparing Rotate…", not "…with 1 file…").
  const subsetDetail =
    chosen.length > 1 ? ` with ${chosen.length} files` : isMulti ? ` with ${subsetLabel}` : '';

  const toggleBranch = (next: 'use' | 'download') => {
    setBranch((prev) => (prev === next ? 'choose' : next));
  };

  const handlePick = async (target: ContinueTarget) => {
    if (adopting !== null) return;
    const targetName = CONTINUE_TARGETS.find((t) => t.id === target)?.name ?? target;
    setAdoptError(null);
    setAdopting(target);
    setStatus(`Preparing ${targetName}${subsetDetail}…`);
    try {
      const docs = await adoptOutputsAsDocs(chosen, sourceName);
      setPendingTransfer(docs, sourceName, producedBy);
      window.location.hash = `#/${target}`;
    } catch (error) {
      setAdoptError(error);
    } finally {
      setAdopting(null);
      setStatus(null);
    }
  };

  const singleName = singleSuggestion(producedBy, sourceName, outputs[0].name);
  // Accessible target names: "Continue <part> in <Tool>". Single outputs
  // name no part ("Continue in Rotate"); multi-output subsets name the
  // picked part or the file count ("Continue Part 2 in Split",
  // "Continue 2 files in Merge").
  const targetAriaLabel = (targetName: string): string => {
    if (!isMulti) return `Continue in ${targetName}`;
    if (subset.length === 1) return `Continue Part ${(subset[0] ?? 0) + 1} in ${targetName}`;
    return `Continue ${subset.length} files in ${targetName}`;
  };
  // G step motion (exact): keyed motion.div, x-slide + fade, 0.26s. Reduced
  // motion collapses to an opacity-only 0.01 crossfade (no slide, labels
  // stay static — busy/status text is never animated).
  const stepTransition = continueStepTransition(reduceMotion);
  const stepInitial = reduceMotion ? { opacity: 0 } : { opacity: 0, x: CONTINUE_STEP_X };
  const stepExit = reduceMotion ? { opacity: 0 } : { opacity: 0, x: -CONTINUE_STEP_X };
  const rowTransition = (
    index: number,
  ): { duration: number; ease: typeof EASE; delay: number } => ({
    duration: reduceMotion ? CONTINUE_REDUCED_DURATION : CONTINUE_ROW_DURATION,
    ease: EASE,
    delay: continueRowDelay(index, reduceMotion),
  });
  const rowInitial = reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 };
  const toggleBase =
    'inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-colors min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/40 focus-visible:ring-offset-1 focus-visible:ring-offset-paper-100 dark:focus-visible:ring-offset-ink-950';
  const toggleActive = 'bg-ink-900 text-paper-50 shadow-sm dark:bg-paper-50 dark:text-ink-900';
  const toggleIdle =
    'border border-paper-300 text-ink-700 hover:bg-paper-200 hover:border-brass-400/30 dark:border-ink-700 dark:text-paper-100 dark:hover:bg-ink-800';
  // Brass focus rings for every picker control (same pair as the toggles).
  const pickerRing =
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass-400/40 focus-visible:ring-offset-1 focus-visible:ring-offset-paper-100 dark:focus-visible:ring-offset-ink-950';

  return (
    <Card className="mt-5">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="font-display text-lg font-semibold tracking-tight text-ink-900 focus:outline-none dark:text-paper-100"
      >
        Done — what&apos;s next?
      </h2>
      <p
        className="mt-1 min-w-0 truncate text-sm text-ink-500 dark:text-ink-300"
        title={sourceName}
      >
        {producer} from {sourceName} — use it in another tool or download it.
      </p>
      <ResultMeta lines={meta} />

      <div
        className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="group"
        aria-label="Next step"
      >
        <button
          ref={useTriggerRef}
          type="button"
          aria-expanded={branch === 'use'}
          onClick={() => toggleBranch('use')}
          className={`${toggleBase} ${branch === 'use' ? toggleActive : toggleIdle}`}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
          Use in another tool
        </button>
        <button
          ref={downloadTriggerRef}
          type="button"
          aria-expanded={branch === 'download'}
          onClick={() => toggleBranch('download')}
          className={`${toggleBase} ${branch === 'download' ? toggleActive : toggleIdle}`}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" x2="12" y1="15" y2="3" />
          </svg>
          Download
        </button>
      </div>

      <AnimatePresence mode="wait">
        {branch === 'use' && (
          <motion.div
            key="continue-use"
            role="group"
            aria-label="Use in another tool"
            initial={stepInitial}
            animate={{ opacity: 1, x: 0 }}
            exit={stepExit}
            transition={stepTransition}
          >
            {isMulti && (
              <div className="mt-4">
                <h3 className="text-sm font-semibold text-ink-700 dark:text-paper-100">
                  Which files continue?
                </h3>
                <button
                  type="button"
                  aria-pressed={subset.length === outputs.length}
                  disabled={adopting !== null}
                  onClick={() => setPicked(null)}
                  className={`mt-2 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-brass-400/40 bg-brass-400/[0.07] px-4 py-2.5 text-sm font-medium text-ink-700 transition-colors hover:bg-brass-400/[0.12] disabled:opacity-40 dark:text-paper-100 ${pickerRing}`}
                >
                  Continue with all {outputs.length} as merge inputs
                </button>
                <ul className="mt-2 space-y-2">
                  {outputs.map((out, i) => {
                    const selected = subset.length === 1 && subset[0] === i;
                    return (
                      <motion.li
                        key={`part-${i}`}
                        initial={rowInitial}
                        animate={{ opacity: 1, y: 0 }}
                        transition={rowTransition(i)}
                        className="flex min-w-0 flex-col items-stretch gap-2 rounded-xl border border-paper-300/70 bg-paper-100 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center dark:border-ink-700 dark:bg-ink-900/60"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink-900 dark:text-paper-100">
                            {partLabel(out, i)}
                          </span>
                          <span className="block text-xs tabular-nums text-ink-400 dark:text-ink-300">
                            {out.pageCount !== null && out.pageCount !== undefined
                              ? `${out.pageCount} pages · `
                              : ''}
                            {formatBytes(out.byteLength)}
                          </span>
                        </span>
                        <button
                          type="button"
                          aria-pressed={selected}
                          aria-label={`Continue with this part (${partLabel(out, i)})`}
                          disabled={adopting !== null}
                          onClick={() => setPicked([i])}
                          className={`inline-flex min-h-[44px] w-full shrink-0 items-center justify-center rounded-lg px-3 py-2 text-[13px] font-semibold transition-colors disabled:opacity-40 sm:w-auto ${pickerRing} ${
                            selected
                              ? 'bg-ink-900 text-paper-50 dark:bg-paper-50 dark:text-ink-900'
                              : 'border border-paper-300 text-ink-700 hover:border-brass-400/40 hover:bg-brass-400/[0.08] dark:border-ink-700 dark:text-paper-100'
                          }`}
                        >
                          Continue with this part
                        </button>
                      </motion.li>
                    );
                  })}
                </ul>
              </div>
            )}

            <h3 className="mt-4 text-sm font-semibold text-ink-700 dark:text-paper-100">
              Pick a tool{isMulti ? ` for ${subsetLabel}` : ''}
            </h3>
            {mergeOnly && (
              <p className="mt-1 text-xs text-ink-400 dark:text-ink-300">
                Multiple files can continue into Merge only — pick a single part above for the other
                tools.
              </p>
            )}
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {CONTINUE_TARGETS.map((target, i) => {
                const disabled = (mergeOnly && target.id !== 'merge') || adopting !== null;
                const busy = adopting === target.id;
                return (
                  <motion.li
                    key={target.id}
                    initial={rowInitial}
                    animate={{ opacity: 1, y: 0 }}
                    transition={rowTransition(i)}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      aria-label={targetAriaLabel(target.name)}
                      onClick={() => void handlePick(target.id)}
                      className={`flex min-h-[44px] w-full flex-col items-start gap-0.5 rounded-xl border border-paper-300 px-4 py-2.5 text-left transition-colors hover:border-brass-400/40 hover:bg-brass-400/[0.07] disabled:cursor-not-allowed disabled:opacity-40 dark:border-ink-700 dark:hover:bg-ink-800 ${pickerRing}`}
                    >
                      <span className="text-sm font-semibold text-ink-900 dark:text-paper-100">
                        {target.name}
                        {busy ? '…' : ''}
                      </span>
                      <span className="text-xs text-ink-400 dark:text-ink-300">
                        {busy ? `Preparing${subsetDetail}…` : target.tagline}
                      </span>
                    </button>
                  </motion.li>
                );
              })}
            </ul>

            {/* Reserved status slot: sized to the tallest status state (the
                longest "Preparing <Tool> with <detail>…" wraps to two
                text-xs lines at 360px), so the async adopting announcement
                never shifts layout. Single live region (polite); adopt
                failures use ErrorBlock's alert role. */}
            <p
              aria-live="polite"
              className="mt-2 min-h-[32px] text-xs text-ink-400 dark:text-ink-300"
            >
              {status}
            </p>
            {adoptError !== null && <ErrorBlock error={adoptError} />}
          </motion.div>
        )}

        {branch === 'download' && (
          <motion.div
            key="continue-download"
            role="group"
            aria-label="Download"
            initial={stepInitial}
            animate={{ opacity: 1, x: 0 }}
            exit={stepExit}
            transition={stepTransition}
          >
            {isMulti ? (
              <MultiDownloadCard parts={parts} shareable={shareable} />
            ) : (
              <DownloadCard blob={blobs[0]} suggestedName={singleName} shareable={shareable} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-4 flex flex-col gap-2 border-t border-paper-200/70 pt-4 sm:flex-row sm:flex-wrap dark:border-ink-700/60">
        <Button variant="ghost" onClick={onBackToEdit} className="min-h-[44px] w-full sm:w-auto">
          Back to edit
        </Button>
      </div>
    </Card>
  );
}

export default ContinueCard;
