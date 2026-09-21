import type { EngineEvent, EngineExecution, EngineRequest } from '../types/engine';

/**
 * Stable engine boundary for the Developer Console (and later the
 * production UI).
 *
 * The UI only ever talks to this interface: it renders forms, builds
 * `EngineRequest`s, subscribes to events, and displays results. It never
 * touches processing logic, workers, WASM modules, HTTP, or Rust
 * internals.
 *
 * Implementations behind this seam (swappable with zero UI changes):
 * `WasmWorkerEngineAdapter` (Web Worker + WASM; production browser path,
 * normal development) → `MockEngineAdapter` (in-process protocol mock;
 * frontend unit tests only, never real execution).
 */
export interface EngineAdapter {
  /** Adapter flavor, surfaced in the UI so mocks are never silent. */
  readonly kind: 'mock' | 'wasm-worker';
  /** True while outcomes are simulated (mock adapter only). */
  readonly simulated: boolean;

  /**
   * Start one operation. Returns the job id synchronously (so callers can
   * subscribe before any event flows) plus a promise for the final record
   * (success, failure, or cancellation).
   */
  execute(request: EngineRequest): { jobId: string; done: Promise<EngineExecution> };

  /** Request cancellation. The in-flight `execute` resolves `cancelled`. */
  cancel(jobId: string): Promise<void>;

  /**
   * Subscribe to a job's events. Replays already-buffered events first,
   * then streams live ones. Returns an unsubscribe function.
   */
  subscribe(jobId: string, listener: (event: EngineEvent) => void): () => void;
}
