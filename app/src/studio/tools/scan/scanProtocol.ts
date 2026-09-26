/**
 * Scan worker protocol (v2): typed, versioned messages between the main
 * thread and `scan.worker.ts`.
 *
 * v2 adds `detectOnly` to `process` (live guidance detects without
 * warping/encoding; the worker answers with status `detected`).
 *
 * Mirrors the `workerProtocol.ts` discipline: every message carries the
 * protocol version; malformed framing is ignored, never thrown. Bytes
 * cross as transferable `ArrayBuffer`s, never inside JSON.
 *
 * Message kinds:
 * - main → worker: `process` (one scan job).
 * - worker → main: `ready` (WASM initialized, accepts jobs),
 *   `status` (coarse honest phase — indeterminate, never fake %),
 *   `result` (terminal envelope + optional output bytes; `detected`
 *   results never carry output bytes),
 *   `fatal` (worker-level failure; the client must recreate the worker).
 */

export const SCAN_PROTOCOL_VERSION = 2;

export type ScanModeName = 'original' | 'grayscale' | 'blackwhite';

export interface ScanProcessRequest {
  protocol: number;
  kind: 'process';
  /** Client job id (`scan-N`, adapter-monotonic). Identity, not a key. */
  jobId: string;
  /** Input image bytes. TRANSFERRED — the sender must not touch it after. */
  buffer: ArrayBuffer;
  mode: ScanModeName;
  /**
   * Detection-only fast path (live guidance): detect and return
   * corners/confidence (status `detected`) WITHOUT warp or JPEG encode.
   * The shutter always sends `false` (full pipeline).
   */
  detectOnly: boolean;
}

export type MainToScanWorker = ScanProcessRequest;

export interface ScanReady {
  protocol: number;
  kind: 'ready';
}

export interface ScanStatus {
  protocol: number;
  kind: 'status';
  jobId: string;
  /** Coarse honest phase. Only `processing` exists in v2.0 M2. */
  phase: 'processing';
}

export interface ScanResultMsg {
  protocol: number;
  kind: 'result';
  jobId: string;
  /** JSON envelope from the glue (`status: processed|original|error`). */
  resultJson: string;
  /** Output JPEG bytes (status `processed` only). TRANSFERRED. */
  output?: ArrayBuffer;
}

export interface ScanFatal {
  protocol: number;
  kind: 'fatal';
  jobId: string | null;
  message: string;
}

export type ScanWorkerToMain = ScanReady | ScanStatus | ScanResultMsg | ScanFatal;

/** Guards one unknown worker message; `null` when framing is malformed. */
export function parseScanMessage(msg: unknown): ScanWorkerToMain | null {
  if (msg === null || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m['protocol'] !== SCAN_PROTOCOL_VERSION) return null;
  switch (m['kind']) {
    case 'ready':
      return msg as ScanReady;
    case 'status':
      return typeof m['jobId'] === 'string' ? (msg as ScanStatus) : null;
    case 'result':
      return typeof m['jobId'] === 'string' && typeof m['resultJson'] === 'string'
        ? (msg as ScanResultMsg)
        : null;
    case 'fatal':
      return typeof m['message'] === 'string' ? (msg as ScanFatal) : null;
    default:
      return null;
  }
}
