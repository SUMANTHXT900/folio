/// <reference lib="webworker" />
/**
 * Dedicated engine Web Worker: owns WASM init + all execution.
 *
 * Lifecycle (§19: init once, execute many):
 *
 * ```text
 * worker boots → import WASM glue → instantiate module → new WasmEngine()
 *   → post {kind:'ready'} → serve execute messages sequentially, forever
 * ```
 *
 * The main thread NEVER touches WASM directly; this worker is the only
 * place the Rust engine runs. Execution is synchronous inside `execute`
 * (blocking this worker is by design — the UI thread stays responsive),
 * so messages are naturally served one at a time in FIFO order.
 *
 * Binary flow: transferred `ArrayBuffer`s arrive neutered on the sender
 * side (zero-copy move). They are wrapped as `Uint8Array` views for the
 * glue, which copies them into WASM linear memory (documented copy).
 * Output `Uint8Array`s from the glue own fresh JS buffers (the glue
 * copies out of WASM memory), so their `.buffer`s are safe to transfer
 * back. No base64 anywhere.
 *
 * Cancellation is intentionally NOT handled here: a synchronous `execute`
 * cannot process another message until it returns, so cooperative cancel
 * is impossible on this thread. The adapter cancels by terminating this
 * worker and creating a fresh one (documented in the adapter).
 */

import init, { WasmEngine } from '../../../wasm/pkg/folio_wasm.js';
import {
  WORKER_PROTOCOL_VERSION,
  type WorkerEngineEvent,
  type WorkerExecuteRequest,
  type WorkerToMain,
} from './workerProtocol';

declare const self: DedicatedWorkerGlobalScope;

let engine: WasmEngine | null = null;

function post(response: WorkerToMain, transfer?: Transferable[]): void {
  // Array form (not the options bag): supported by every worker runtime,
  // including the jsdom-less unit-test doubles.
  if (transfer === undefined) {
    self.postMessage(response);
  } else {
    self.postMessage(response, transfer);
  }
}

function fail(clientJobId: string, message: string): void {
  post({ protocol: WORKER_PROTOCOL_VERSION, kind: 'fatal', clientJobId, message });
}

self.onmessage = (ev: MessageEvent<WorkerExecuteRequest>): void => {
  const msg = ev.data;
  if (msg === null || typeof msg !== 'object' || msg.protocol !== WORKER_PROTOCOL_VERSION) {
    return; // Malformed framing is the adapter's bug; ignore, never throw.
  }
  if (msg.kind !== 'execute') {
    fail(msg.clientJobId, `unknown worker request kind: ${String(msg.kind)}`);
    return;
  }

  try {
    if (engine === null) {
      // Only reachable when boot-time init failed (see below): every
      // execute then fails fast with a clear message instead of hanging.
      throw new Error('WASM engine not initialized (see worker console for the init error)');
    }
    const names = msg.inputs.map((input) => input.name);
    const blobs = msg.inputs.map((input) => new Uint8Array(input.buffer));
    const optionsJson = JSON.stringify(msg.options);
    const emit = (json: string): void => {
      post({
        protocol: WORKER_PROTOCOL_VERSION,
        kind: 'event',
        clientJobId: msg.clientJobId,
        event: JSON.parse(json) as WorkerEngineEvent,
      });
    };
    const out = engine.execute(msg.operation, names, blobs, optionsJson, emit) as {
      result_json: string;
      outputs: Uint8Array[];
    };
    const outputs = out.outputs.map((view) => {
      // `Uint8Array::from` in the glue allocates a FRESH JS buffer per
      // output (it copies out of WASM linear memory), so transferring
      // `.buffer` cannot neuter WASM memory. No extra copy here.
      const buffer = view.buffer as ArrayBuffer;
      return buffer;
    });
    post(
      {
        protocol: WORKER_PROTOCOL_VERSION,
        kind: 'result',
        clientJobId: msg.clientJobId,
        resultJson: out.result_json,
        outputs,
      },
      [...outputs],
    );
  } catch (error) {
    // Glue throws only for glue-level misuse; engine errors arrive INSIDE
    // result_json instead. A throw here (or a WASM panic, surfaced by
    // wasm-bindgen as an exception) becomes a fatal job failure.
    fail(msg.clientJobId, error instanceof Error ? error.message : 'unknown worker failure');
  }
};

// Eager init at boot so the adapter's readiness handshake is meaningful:
// by the time {kind:'ready'} arrives, the WASM module is instantiated and
// the engine handle exists. A failed init posts nothing — the adapter's
// ready-timeout surfaces it as an initialization failure instead.
(async (): Promise<void> => {
  try {
    await init();
    engine = new WasmEngine();
    post({ protocol: WORKER_PROTOCOL_VERSION, kind: 'ready' });
  } catch (error) {
    // Init failure is silent here by necessity (nothing to send it to
    // reliably); the adapter times out waiting for 'ready' and reports it.
    console.error('folio engine worker init failed:', error);
  }
})();
