import { useEffect } from 'react';
import type { StudioJob } from '../services/folio';

/**
 * Tools whose engine runs surface a mid-run cancellation as a friendly
 * `Error` (instead of the raw `CANCELLED` engine failure). The strings are
 * per-tool UI copy — kept byte-identical here so the five catch sites share
 * one source without drifting.
 */
export type CancellableTool = 'merge' | 'metadata' | 'rotate' | 'rearrange' | 'split';

/**
 * Builds the mid-run cancellation error for a tool. Callers keep owning the
 * `code === 'CANCELLED'` branch shape — only the message construction is
 * shared, so a wrong-tool message can never slip in silently.
 */
export function cancelledError(tool: CancellableTool): Error {
  switch (tool) {
    case 'merge':
      return new Error('Merge cancelled.');
    case 'metadata':
      return new Error('Metadata save cancelled.');
    case 'rotate':
      return new Error('Rotate cancelled.');
    case 'rearrange':
      return new Error('Rearrange cancelled.');
    case 'split':
      return new Error('Split cancelled.');
  }
}

/**
 * Cancels the running job when the user navigates away. The job settles the
 * UI via the tool's own run catch/finally — this effect never touches tool
 * state directly, so it stays safe to share across tools.
 */
export function useCancelOnUnmount(jobRef: { current: StudioJob | null }): void {
  useEffect(
    () => () => {
      void jobRef.current?.cancel();
    },
    [],
  );
}
