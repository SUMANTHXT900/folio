import { useEffect, useRef, useState } from 'react';
import {
  closeStudioDoc,
  consumePendingTransfer,
  getStudioBytes,
  type StudioDoc,
} from '../services/folio';

/**
 * Which pending-transfer shape a tool consumes. `'multi'` (Merge) prepends
 * every live handed-off doc ahead of the existing inputs; `'single'` (all
 * other PDF tools) adopts only the first live doc, and only when the tool
 * has no input yet — extras are ignored, never uploaded, never in state.
 */
export type PendingTransferMode = 'multi' | 'single';

export interface ContinuedFrom {
  producedBy: string;
  sourceName: string;
}

/**
 * Shared pending-transfer intake (mount once) for the PDF tools.
 *
 * A handed-off doc lands as an input by reference — no re-upload, no bytes
 * in state, only the handle is verified live (`getStudioBytes` existence
 * check, result discarded).
 *
 * Claim lifecycle (P5-1): docs handed off by another tool are referenced
 * (never copied) into this mount's inputs. The claim releases on unmount
 * only when the user backs out without running (`ranRef` — the tool sets
 * `ranRef.current = true` when its engine run starts). `mountGenRef` plus
 * the deferred release keep React StrictMode's fake unmount/remount from
 * destroying the claim: the fake unmount is always superseded by a remount
 * (generation check) before the timer fires, so only a real unmount
 * releases the un-run claim via `closeStudioDoc` (frees bytes + render
 * docs + thumb URLs).
 *
 * Callers keep owning their row-remove/clear paths: filter `claimedRef`
 * when a claimed doc leaves state (see MergeTool's remove/clear), so the
 * back-out release never double-closes.
 */
export function usePendingTransfer(
  setFiles: (update: StudioDoc[] | ((prev: StudioDoc[]) => StudioDoc[])) => void,
  mode: PendingTransferMode,
) {
  const [continuedFrom, setContinuedFrom] = useState<ContinuedFrom | null>(null);
  // Pending-transfer claim: docs handed off by another tool, referenced
  // (never copied) into this mount's inputs.
  const claimedRef = useRef<StudioDoc[]>([]);
  const ranRef = useRef(false);
  const mountGenRef = useRef(0);

  useEffect(() => {
    mountGenRef.current += 1;
    const gen = mountGenRef.current;
    const pending = consumePendingTransfer();
    if (pending !== null) {
      const live = pending.docs.filter((d) => getStudioBytes(d.id) !== undefined);
      if (mode === 'multi') {
        if (live.length > 0) {
          claimedRef.current = live;
          setFiles((prev) => {
            const seen = new Set(prev.map((f) => f.id));
            return [...live.filter((d) => !seen.has(d.id)), ...prev];
          });
          setContinuedFrom({ producedBy: pending.producedBy, sourceName: pending.sourceName });
        }
      } else {
        const firstDoc: StudioDoc | undefined = live.length > 0 ? live[0] : undefined;
        if (firstDoc !== undefined) {
          claimedRef.current = [firstDoc];
          setFiles((prev) => (prev.length > 0 ? prev : [firstDoc]));
          setContinuedFrom({ producedBy: pending.producedBy, sourceName: pending.sourceName });
        }
      }
    }
    return () => {
      // Back-out release, deferred one task: StrictMode's fake unmount is
      // always superseded by a remount (generation check) before the timer
      // fires, so only a real unmount releases the un-run claim (P5-1:
      // `closeStudioDoc` frees bytes + render docs + thumb URLs).
      const claimed = claimedRef.current;
      window.setTimeout(() => {
        if (mountGenRef.current !== gen) return;
        claimedRef.current = claimedRef.current.filter((d) => !claimed.some((c) => c.id === d.id));
        if (ranRef.current) return;
        for (const d of claimed) void closeStudioDoc(d.id);
      }, 0);
    };
  }, [setFiles, mode]);

  return { claimedRef, ranRef, continuedFrom, setContinuedFrom };
}
