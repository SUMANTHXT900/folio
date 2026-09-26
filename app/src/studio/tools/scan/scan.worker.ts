/// <reference lib="webworker" />
/**
 * Dedicated scan Web Worker: owns folio-scan WASM init + all scan jobs.
 *
 * Lifecycle (mirrors `engine.worker.ts` §19):
 *
 * ```text
 * worker boots → import WASM glue → instantiate module → scan_init()
 *   → post {kind:'ready'} → serve process messages sequentially, forever
 * ```
 *
 * Separate from the PDF engine worker on purpose: different
 * responsibility (image analysis vs PDF manipulation), different module,
 * independent lifecycle. The main thread NEVER touches scan WASM
 * directly.
 *
 * Binary flow: input `ArrayBuffer`s arrive TRANSFERRED (neutered on the
 * sender side — the client must not touch them after posting). The glue
 * takes ownership of the bytes with a single JS→WASM copy; output bytes
 * come back as fresh buffers, transferred to main. No base64 anywhere.
 *
 * Live guidance uses `detectOnly` process requests: detection only, no
 * warp/JPEG output bytes on the wire.
 *
 * Cancellation follows Folio philosophy: the client terminates this
 * worker. A synchronous WASM call cannot observe cancellation mid-flight,
 * so there is no cooperative cancel inside a job — termination is the
 * mechanism and stale results are discarded client-side by job identity.
 */

import init, { scan_init, scan_process } from '../../../../../scan/pkg/folio_scan.js';
import {
  SCAN_PROTOCOL_VERSION,
  type MainToScanWorker,
  type ScanWorkerToMain,
} from './scanProtocol';

declare const self: DedicatedWorkerGlobalScope;

let ready = false;

function post(response: ScanWorkerToMain, transfer?: Transferable[]): void {
  // Array form (not the options bag): supported by every worker runtime,
  // including the jsdom-less unit-test doubles.
  if (transfer === undefined) {
    self.postMessage(response);
  } else {
    self.postMessage(response, transfer);
  }
}

function fail(jobId: string | null, message: string): void {
  post({ protocol: SCAN_PROTOCOL_VERSION, kind: 'fatal', jobId, message });
}

// Eager init at boot so the client's readiness handshake is meaningful:
// by the time {kind:'ready'} arrives, the WASM module is instantiated.
// A failed init posts a fatal instead (nothing to handshake with); the
// client treats it as an initialization failure.
(async (): Promise<void> => {
  try {
    await init();
    scan_init();
    ready = true;
    post({ protocol: SCAN_PROTOCOL_VERSION, kind: 'ready' });
  } catch (error) {
    fail(
      null,
      error instanceof Error ? `scan WASM init failed: ${error.message}` : 'scan WASM init failed',
    );
  }
})();

self.onmessage = (ev: MessageEvent<MainToScanWorker>): void => {
  const msg = ev.data;
  if (msg === null || typeof msg !== 'object' || msg.protocol !== SCAN_PROTOCOL_VERSION) {
    return; // Malformed framing is the client's bug; ignore, never throw.
  }
  if (msg.kind !== 'process' || !ready) {
    fail(
      msg.kind === 'process' ? msg.jobId : null,
      ready ? `unknown scan request kind` : 'scan WASM not initialized',
    );
    return;
  }
  const { jobId, buffer, mode, detectOnly } = msg;
  // Honest coarse status: one indeterminate phase. The core exposes no
  // stage spans in M2, so no percentages are synthesized (L-5).
  post({ protocol: SCAN_PROTOCOL_VERSION, kind: 'status', jobId, phase: 'processing' });
  try {
    const input = new Uint8Array(buffer);
    const envelope = scan_process(input, mode, detectOnly) as {
      result_json: string;
      output: Uint8Array | null;
    };
    if (envelope.output !== null) {
      const out = envelope.output;
      post(
        {
          protocol: SCAN_PROTOCOL_VERSION,
          kind: 'result',
          jobId,
          resultJson: envelope.result_json,
          output: out.buffer as ArrayBuffer,
        },
        [out.buffer as ArrayBuffer],
      );
    } else {
      post({
        protocol: SCAN_PROTOCOL_VERSION,
        kind: 'result',
        jobId,
        resultJson: envelope.result_json,
      });
    }
  } catch (error) {
    fail(
      jobId,
      error instanceof Error ? `scan process failed: ${error.message}` : 'scan process failed',
    );
  }
};
