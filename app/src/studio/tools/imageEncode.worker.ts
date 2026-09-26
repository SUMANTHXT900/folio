/// <reference lib="webworker" />
/**
 * Image JPEG encode worker (PERFORMANCE.md P2 item 11: findings 12 +
 * 13-import-side). Moves the canvas JPEG encode off the main thread:
 * white-fill + draw + `convertToBlob` run here on an `OffscreenCanvas`.
 *
 * Transfer discipline: the caller transfers its `ImageBitmap`; this
 * worker closes it on EVERY path (success and failure). The sender's
 * copy is neutered by the transfer, so the caller must not draw with it
 * afterwards — only `close()` (a harmless no-op on a neutered handle).
 *
 * No decoding happens here: `createImageBitmap` stays on the main
 * thread (a video/file source cannot cross cheaply), and the import
 * queue keeps its one-image-at-a-time discipline — one in-flight encode
 * per caller, sequential by construction.
 *
 * Protocol v1 (single producer/consumer; worker and client ship together):
 * - worker → main on boot: `{protocol, kind:'ready', offscreen}` (`offscreen`
 *   false when this runtime lacks `OffscreenCanvas.convertToBlob`;
 *   the client then never sends work and uses its main-thread path).
 * - main → worker: `{protocol, kind:'encode', id, bitmap, width, height,
 *   quality, flipHorizontal}` (bitmap transferred). `protocol` is accepted
 *   when missing (the current client predates versioning) but when present
 *   it MUST equal `ENCODE_PROTOCOL_VERSION`.
 * - worker → main: `{protocol, kind:'result', id, ok, buffer?, message?}`
 *   (pixel buffer transferred back on success).
 *
 * Single-flight discipline lives with the caller (the import queue runs
 * concurrency 1, sequential by construction): this worker correlates
 * replies by `id`, closes the transferred bitmap on EVERY path, and
 * answers malformed jobs with a bounded `ok:false` result — never silence
 * (silence would force the client into its 30 s timeout). Only jobs
 * without a routable numeric `id` are ignored (uncorrelatable).
 */
/**
 * Local scope alias (NOT a global `declare const self`: the program
 * already has two worker files redeclaring that global — a third
 * trips TS2451. Reading the DOM-lib `self` through one alias avoids
 * the clash while keeping worker-typed `postMessage`/`onmessage`).
 */
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

/** Encode protocol version (v1: initial versioned framing). */
export const ENCODE_PROTOCOL_VERSION = 1;

interface EncodeRequestMessage {
  /** Absent on pre-v1 clients; when present it MUST be 1. */
  protocol?: number;
  kind: 'encode';
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  quality: number;
  flipHorizontal: boolean;
}

interface ReadyMessage {
  protocol: number;
  kind: 'ready';
  offscreen: boolean;
}

interface ResultMessage {
  protocol: number;
  kind: 'result';
  id: number;
  ok: boolean;
  buffer?: ArrayBuffer;
  message?: string;
}

function supportsEncode(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof (OffscreenCanvas.prototype as unknown as { convertToBlob?: unknown }).convertToBlob ===
      'function'
  );
}

// Announce synchronously at boot so the client's readiness handshake
// is meaningful: `offscreen` reports encode capability, never WASM.
workerScope.postMessage({
  protocol: ENCODE_PROTOCOL_VERSION,
  kind: 'ready',
  offscreen: supportsEncode(),
} satisfies ReadyMessage);

/** Best-effort release of a transferred bitmap on paths that never encode. */
function closeBitmap(candidate: unknown): void {
  try {
    (candidate as { close?: () => void } | null | undefined)?.close?.();
  } catch {
    // Release best-effort; the bounded error reply is what matters.
  }
}

function failJob(id: number, message: string, bitmap: unknown): void {
  closeBitmap(bitmap);
  workerScope.postMessage({
    protocol: ENCODE_PROTOCOL_VERSION,
    kind: 'result',
    id,
    ok: false,
    message,
  } satisfies ResultMessage);
}

workerScope.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as Partial<EncodeRequestMessage> | null;
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'encode') {
    return; // Unknown framing, unroutable: ignore, never throw.
  }
  const { protocol, id, bitmap, width, height, quality, flipHorizontal } = msg;
  // Bounded replies for malformed jobs: whenever the job carries a routable
  // numeric `id`, answer `ok:false` with operation context instead of staying
  // silent and forcing the client into its 30 s timeout. Jobs without an `id`
  // cannot be correlated — those alone are ignored.
  if (typeof id !== 'number') {
    return;
  }
  if (protocol !== undefined && protocol !== ENCODE_PROTOCOL_VERSION) {
    failJob(
      id,
      `Unsupported encode protocol ${String(protocol)} (worker speaks ${ENCODE_PROTOCOL_VERSION}).`,
      bitmap,
    );
    return;
  }
  if (
    bitmap === undefined ||
    !(typeof width === 'number' && width > 0) ||
    !(typeof height === 'number' && height > 0)
  ) {
    failJob(
      id,
      `Malformed encode job (id=${String(id)}, width=${String(width)}, height=${String(height)}): expected a bitmap and positive dimensions.`,
      bitmap,
    );
    return;
  }
  void (async (): Promise<void> => {
    try {
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('2D context unavailable in encode worker.');
      // White-fill first: transparent PNG pixels must composite to white
      // (JPEG has no alpha; an unfilled canvas bakes them to black).
      // (Same fill as the main-thread fallback — outputs are identical.)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      // Front-camera captures are un-mirrored here instead of on the
      // main-thread canvas (same transform, same pixels).
      if (flipHorizontal === true) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
      // `arrayBuffer()` yields a fresh exact-range buffer: transfer moves
      // ownership to main; this worker must not touch it after posting.
      const buffer = await blob.arrayBuffer();
      workerScope.postMessage(
        {
          protocol: ENCODE_PROTOCOL_VERSION,
          kind: 'result',
          id,
          ok: true,
          buffer,
        } satisfies ResultMessage,
        [buffer],
      );
    } catch (error) {
      try {
        bitmap.close();
      } catch {
        // Release best-effort; the failure below is what matters.
      }
      workerScope.postMessage({
        protocol: ENCODE_PROTOCOL_VERSION,
        kind: 'result',
        id,
        ok: false,
        message:
          error instanceof Error
            ? `Encode failed (id=${String(id)}, ${String(width)}x${String(height)}): ${error.message}`
            : `Encode failed (id=${String(id)}, ${String(width)}x${String(height)}).`,
      } satisfies ResultMessage);
    }
  })();
};
