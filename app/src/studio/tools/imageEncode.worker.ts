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
 * Protocol (local-only, single producer/consumer — no version field;
 * worker and client ship together):
 * - worker → main on boot: `{kind:'ready', offscreen}` (`offscreen`
 *   false when this runtime lacks `OffscreenCanvas.convertToBlob`;
 *   the client then never sends work and uses its main-thread path).
 * - main → worker: `{kind:'encode', id, bitmap, width, height,
 *   quality, flipHorizontal}` (bitmap transferred).
 * - worker → main: `{kind:'result', id, ok, buffer?, message?}`
 *   (pixel buffer transferred back on success).
 */
/**
 * Local scope alias (NOT a global `declare const self`: the program
 * already has two worker files redeclaring that global — a third
 * trips TS2451. Reading the DOM-lib `self` through one alias avoids
 * the clash while keeping worker-typed `postMessage`/`onmessage`).
 */
const workerScope = self as unknown as DedicatedWorkerGlobalScope;

interface EncodeRequestMessage {
  kind: 'encode';
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  quality: number;
  flipHorizontal: boolean;
}

interface ReadyMessage {
  kind: 'ready';
  offscreen: boolean;
}

interface ResultMessage {
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
workerScope.postMessage({ kind: 'ready', offscreen: supportsEncode() } satisfies ReadyMessage);

workerScope.onmessage = (ev: MessageEvent): void => {
  const msg = ev.data as Partial<EncodeRequestMessage> | null;
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'encode') {
    return; // Unknown framing: ignore, never throw.
  }
  const { id, bitmap, width, height, quality, flipHorizontal } = msg;
  if (
    typeof id !== 'number' ||
    bitmap === undefined ||
    !(typeof width === 'number' && width > 0) ||
    !(typeof height === 'number' && height > 0)
  ) {
    return; // Malformed job: ignore (the client's timeout rejects it).
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
      const buffer = await blob.arrayBuffer();
      workerScope.postMessage({ kind: 'result', id, ok: true, buffer } satisfies ResultMessage, [
        buffer,
      ]);
    } catch (error) {
      try {
        bitmap.close();
      } catch {
        // Release best-effort; the failure below is what matters.
      }
      workerScope.postMessage({
        kind: 'result',
        id,
        ok: false,
        message: error instanceof Error ? error.message : 'Encode worker failed.',
      } satisfies ResultMessage);
    }
  })();
};
