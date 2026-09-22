/**
 * Web-Worker protocol for the real WASM engine runtime.
 *
 * ```text
 * Main thread (WasmWorkerEngineAdapter)
 *   │  WorkerExecuteRequest (inputs as TRANSFERRED ArrayBuffers)
 *   ▼
 * Web Worker (engine.worker.ts)
 *   │  WorkerToMain: ready → events… → result | fatal
 *   ▼
 * Main thread (adapter translates to EngineExecution)
 * ```
 *
 * Summary shapes are shared with the translation layer
 * (`engineResult.ts`): the wire format is defined once, and only the
 * framing differs (`postMessage` with transferable buffers;
 * `WORKER_PROTOCOL_VERSION` guards the framing, currently 1).
 */

import type { OperationId } from '../types/engine';
import type {
  EngineCountsSummary,
  EngineInspectSummary,
  EngineMergeSummary,
  EngineMetadataSummary,
  EngineSplitSummary,
} from './engineResult';

export const WORKER_PROTOCOL_VERSION = 1;

export type WorkerSummary =
  | EngineInspectSummary
  | EngineCountsSummary
  | EngineSplitSummary
  | EngineMergeSummary
  | EngineMetadataSummary;

/** Main → worker: run one operation. Buffers are transferred (moved). */
export interface WorkerExecuteRequest {
  protocol: typeof WORKER_PROTOCOL_VERSION;
  kind: 'execute';
  clientJobId: string;
  operation: OperationId;
  inputs: Array<{ name: string; buffer: ArrayBuffer }>;
  options: Record<string, unknown>;
}

/** One engine event, as emitted by the WASM glue callback. */
export interface WorkerEngineEvent {
  timestamp_ms: number;
  kind: 'progress' | 'log' | 'lifecycle';
  level?: 'debug' | 'info' | 'warn' | 'error';
  phase?: string | null;
  completed?: number;
  total?: number;
  /** 0.0–1.0 fraction. */
  percentage?: number | null;
  message?: string | null;
  engine_job_id?: string | null;
}

export interface WorkerOutputRef {
  index: number;
  name: string;
  byte_length: number;
  page_count: number;
}

export interface WorkerResultEnvelope {
  engine_job_id: string | null;
  operation: string;
  state: 'completed' | 'failed' | 'cancelled';
  started_at_ms?: number;
  completed_at_ms?: number;
  /** Authoritative monotonic engine duration in milliseconds. */
  duration_ms?: number;
  progress: number | null;
  result: { summary: WorkerSummary; outputs: WorkerOutputRef[] } | null;
  error: { code: string; message: string; details?: string | null } | null;
  event_count: number;
}

export type WorkerToMain =
  | { protocol: typeof WORKER_PROTOCOL_VERSION; kind: 'ready' }
  | {
      protocol: typeof WORKER_PROTOCOL_VERSION;
      kind: 'event';
      clientJobId: string;
      event: WorkerEngineEvent;
    }
  | {
      protocol: typeof WORKER_PROTOCOL_VERSION;
      kind: 'result';
      clientJobId: string;
      /** The glue's `result_json` envelope. */
      resultJson: string;
      /** Output PDFs, aligned with `result.outputs[].index`. Transferred. */
      outputs: ArrayBuffer[];
    }
  | {
      protocol: typeof WORKER_PROTOCOL_VERSION;
      kind: 'fatal';
      clientJobId: string;
      message: string;
    };
