/**
 * In-process mock engine behind the `EngineAdapter` boundary.
 *
 * WHAT THIS IS: a faithful implementation of the engine *protocol* —
 * job lifecycle, progress events (`phase/completed/total/message`),
 * monotonic engine timing, cooperative cancellation, and structured
 * errors using the real Rust `ErrorCode` wire strings with the same
 * validation rules (range checks before duplicate checks, permutation
 * rules for reorder, quarter-turn rules for rotate, etc.). It exists so
 * frontend unit tests (`npm test`) run offline with zero infrastructure:
 * no bridge, no server, no network.
 *
 * WHAT THIS IS NOT: real PDF processing. Document properties (page
 * counts, dimensions) are deterministic stand-ins derived per input, and
 * output documents are minimal valid PDFs from `placeholderPdf.ts`.
 * Every event/result carries `simulated: true`, and the UI shows a mock
 * banner whenever this adapter is active.
 *
 * NEVER use this adapter for real development verification — that is the
 * job of `WasmWorkerEngineAdapter` (Web Worker + WASM → real Rust
 * engine). The mock must never be confused with real engine execution.
 */

import { registerBytes } from './binaryStore';
import type { EngineAdapter } from './EngineAdapter';
import { makePlaceholderPdf } from './placeholderPdf';
import type {
  EngineErrorData,
  EngineEvent,
  EngineExecution,
  EngineRequest,
  ErrorCode,
  InspectOptions,
  InspectSummary,
  MetadataPatchOptions,
  MetadataSummary,
  OutputDocumentRef,
  PageSelectionOptions,
  ReorderOptions,
  ResultSummary,
  RotateOptions,
  SplitOptions,
} from '../types/engine';

interface SimDocument {
  name: string;
  pageCount: number;
  pdfVersion: string;
  title: string | null;
}

interface JobRecord {
  cancelled: boolean;
  listeners: Set<(event: EngineEvent) => void>;
  events: EngineEvent[];
  seq: number;
}

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic stand-in document properties (see module docs). */
export function simulateDocument(name: string, bytes: Uint8Array): SimDocument {
  const pageCount = 1 + (fnv1a(bytes) % 24);
  const title = name.replace(/\.pdf$/i, '') || null;
  return { name, pageCount, pdfVersion: '1.7', title };
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 8 && PDF_MAGIC.every((byte, index) => bytes[index] === byte);
}

const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];

function isImageBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 4) {
    return false;
  }
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = bytes.length >= 8 && PNG_MAGIC.every((byte, index) => bytes[index] === byte);
  return isJpeg || isPng;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function opError(code: ErrorCode, message: string, details?: string): EngineErrorData {
  return details === undefined ? { code, message } : { code, message, details };
}

export class MockEngineAdapter implements EngineAdapter {
  readonly kind = 'mock' as const;
  readonly simulated = true;

  private jobCounter = 0;
  private readonly jobs = new Map<string, JobRecord>();

  subscribe(jobId: string, listener: (event: EngineEvent) => void): () => void {
    const record = this.jobs.get(jobId);
    if (record === undefined) {
      return () => undefined;
    }
    // Replay buffered events so early lifecycle events are never missed,
    // then stream live ones — the same contract a worker adapter upholds.
    for (const event of record.events) {
      listener(event);
    }
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  async cancel(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId);
    if (record !== undefined) {
      record.cancelled = true;
    }
  }

  execute(request: EngineRequest): { jobId: string; done: Promise<EngineExecution> } {
    this.jobCounter += 1;
    const jobId = `job-${this.jobCounter}`;
    const record: JobRecord = {
      cancelled: false,
      listeners: new Set(),
      events: [],
      seq: 0,
    };
    this.jobs.set(jobId, record);
    return { jobId, done: this.run(jobId, record, request) };
  }

  private async run(
    jobId: string,
    record: JobRecord,
    request: EngineRequest,
  ): Promise<EngineExecution> {
    const startedAt = new Date().toISOString();
    const startMark = performance.now();
    const emit = (
      partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>,
    ): void => {
      record.seq += 1;
      const event: EngineEvent = {
        ...partial,
        jobId,
        seq: record.seq,
        timestampMs: Date.now(),
        simulated: true,
      };
      record.events.push(event);
      for (const listener of record.listeners) {
        listener(event);
      }
    };

    const finish = (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ): EngineExecution => {
      const engineDurationMs = performance.now() - startMark;
      const completedAt = new Date().toISOString();
      const progress = status === 'completed' ? 1 : this.lastProgress(record);
      emit({
        kind: 'lifecycle',
        level: status === 'completed' ? 'info' : 'error',
        message:
          status === 'completed'
            ? 'job completed'
            : status === 'cancelled'
              ? 'job cancelled'
              : 'job failed',
      });
      return {
        jobId,
        // The mock IS the (simulated) engine, so both ids coincide.
        engineJobId: jobId,
        operation: request.operation,
        status,
        startedAt,
        completedAt,
        engineDurationMs,
        progress,
        ...outcome,
        events: [...record.events],
        simulated: true,
      };
    };

    const fail = (error: EngineErrorData): EngineExecution => finish('failed', { error });
    const cancelled = (): EngineExecution =>
      finish('cancelled', {
        error: opError('CANCELLED', 'operation was cancelled'),
      });

    emit({ kind: 'lifecycle', level: 'info', message: 'job started' });

    // Input validation mirrors the engine: readable bytes required.
    // Image inputs (JPEG/PNG magic) replace the PDF check for images_to_pdf.
    if (request.operation === 'pdf.images_to_pdf') {
      if (request.inputs.length === 0) {
        return fail(opError('INVALID_INPUT', 'images_to_pdf requires at least one input image'));
      }
      for (const input of request.inputs) {
        if (input.bytes.length === 0 || !isImageBytes(input.bytes)) {
          emit({ kind: 'log', level: 'error', message: 'input is not a readable image' });
          return fail(
            opError('UNSUPPORTED_FORMAT', `image "${input.name}" format is not supported`),
          );
        }
      }
    } else {
      for (const input of request.inputs) {
        if (input.bytes.length === 0 || !isPdfBytes(input.bytes)) {
          emit({ kind: 'log', level: 'error', message: 'input is not a readable PDF document' });
          return fail(opError('INVALID_DOCUMENT', 'input is not a readable PDF document'));
        }
      }
      if (request.inputs.length === 0 && request.operation !== 'pdf.merge') {
        return fail(opError('INVALID_INPUT', 'no input document provided'));
      }
    }

    try {
      switch (request.operation) {
        case 'pdf.inspect':
          return await this.runInspect(request, emit, record, finish, cancelled);
        case 'pdf.extract_pages':
        case 'pdf.split':
        case 'pdf.reorder':
        case 'pdf.delete_pages':
        case 'pdf.rotate':
        case 'pdf.merge':
          return await this.runTransform(request, emit, record, finish, fail, cancelled);
        case 'pdf.images_to_pdf':
          return await this.runImagesToPdf(request, emit, record, finish, fail, cancelled);
        case 'pdf.read_metadata':
          return await this.runReadMetadata(request, emit, record, finish, cancelled);
        case 'pdf.set_metadata':
          return await this.runSetMetadata(request, emit, record, finish, fail, cancelled);
        default:
          return fail(opError('INVALID_OPTIONS', `unknown operation`));
      }
    } catch (error) {
      // Defensive: the simulator itself must never throw unstructured errors.
      const message = error instanceof Error ? error.message : 'unknown internal error';
      return fail(opError('INTERNAL', message));
    }
  }

  private lastProgress(record: JobRecord): number {
    for (let i = record.events.length - 1; i >= 0; i -= 1) {
      const percentage = record.events[i].percentage;
      if (percentage !== undefined) {
        return percentage;
      }
    }
    return 0;
  }

  private async runInspect(
    request: EngineRequest,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    record: JobRecord,
    finish: (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ) => EngineExecution,
    cancelled: () => EngineExecution,
  ): Promise<EngineExecution> {
    const options = request.options as InspectOptions;
    const doc = simulateDocument(request.inputs[0].name, request.inputs[0].bytes);
    const detailed = options.level === 'detailed';

    await this.drive(
      record,
      emit,
      cancelled,
      [
        { phase: 'parsing', message: 'parsing PDF structure', steps: 3 },
        { phase: 'inspecting', message: 'reading document properties', steps: 3 },
        ...(detailed
          ? [{ phase: 'pages', message: `inspecting ${doc.pageCount} pages`, steps: doc.pageCount }]
          : []),
      ],
      async () => {},
    );
    if (record.cancelled) {
      return cancelled();
    }

    return finish('completed', {
      result: {
        summary: {
          pageCount: doc.pageCount,
          pdfVersion: doc.pdfVersion,
          encrypted: false,
          metadata: { title: doc.title, author: null, producer: 'folio-testbench (simulated)' },
          pages: detailed
            ? Array.from({ length: doc.pageCount }, (_, i) => ({
                pageNumber: i + 1,
                widthPt: 612,
                heightPt: 792,
                rotationDeg: 0,
              }))
            : null,
        } satisfies InspectSummary as ResultSummary,
        outputs: [],
      },
    });
  }

  /**
   * Chunked runner shared by all operations. Each chunk awaits a timer so
   * cancellation is observable and progress actually streams; `onChunk`
   * performs the (simulated) unit of work for observability only.
   */
  private async drive(
    record: JobRecord,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    cancelled: () => EngineExecution,
    phases: Array<{ phase: string; message: string; steps: number }>,
    onChunk: (phase: string, step: number, steps: number) => void,
  ): Promise<EngineExecution | null> {
    const totalSteps = phases.reduce((sum, phase) => sum + phase.steps, 0);
    let done = 0;
    for (const { phase, message, steps } of phases) {
      for (let step = 1; step <= steps; step += 1) {
        await sleep(18);
        if (record.cancelled) {
          return cancelled();
        }
        done += 1;
        const percentage = done / totalSteps;
        emit({
          kind: 'progress',
          phase,
          completed: done,
          total: totalSteps,
          percentage,
          message: `${message} (${done}/${totalSteps})`,
        });
        onChunk(phase, step, steps);
      }
    }
    return null;
  }

  private async runTransform(
    request: EngineRequest,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    record: JobRecord,
    finish: (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ) => EngineExecution,
    fail: (error: EngineErrorData) => EngineExecution,
    cancelled: () => EngineExecution,
  ): Promise<EngineExecution> {
    const docs = request.inputs.map((input) => simulateDocument(input.name, input.bytes));
    const pageCounts = docs.map((doc) => doc.pageCount);

    // Option validation mirrors the Rust operations (same codes, same
    // check order: range before duplicates; reorder length rules).
    const validation = validateTransformOptions(request.operation, request.options, pageCounts);
    if (validation !== null) {
      emit({ kind: 'log', level: 'error', message: validation.message });
      return fail(validation);
    }

    const totalPages = pageCounts.reduce((sum, count) => sum + count, 0);
    const earlyStop = await this.drive(
      record,
      emit,
      cancelled,
      [
        { phase: 'validating', message: 'validating request', steps: 2 },
        { phase: 'preparing', message: 'preparing documents', steps: 2 },
        {
          phase: 'copying',
          message: 'copying pages',
          steps: Math.min(Math.max(totalPages, 4), 40),
        },
        { phase: 'finalizing', message: 'finalizing output', steps: 2 },
      ],
      () => {},
    );
    if (earlyStop !== null) {
      return earlyStop;
    }

    return finish('completed', {
      result: buildTransformResult(request, docs),
    });
  }

  private async runImagesToPdf(
    request: EngineRequest,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    record: JobRecord,
    finish: (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ) => EngineExecution,
    fail: (error: EngineErrorData) => EngineExecution,
    cancelled: () => EngineExecution,
  ): Promise<EngineExecution> {
    if (request.operation !== 'pdf.images_to_pdf') {
      return fail(opError('INVALID_OPTIONS', 'unknown operation'));
    }
    const imageCount = request.inputs.length;
    const earlyStop = await this.drive(
      record,
      emit,
      cancelled,
      [
        { phase: 'validating', message: 'validating image list', steps: 1 },
        { phase: 'preparing', message: 'preparing destination', steps: 1 },
        {
          phase: 'processing images',
          message: `processing ${imageCount} images`,
          steps: Math.min(Math.max(imageCount, 2), 40),
        },
        { phase: 'finalizing', message: 'finalizing output', steps: 1 },
      ],
      () => {},
    );
    if (earlyStop !== null) {
      return earlyStop;
    }

    return finish('completed', {
      result: {
        summary: { pageCount: imageCount, imageCount },
        outputs: [
          (() => {
            const built = makeOutput('images.pdf', imageCount, `images ${imageCount} pages`);
            const outputId = registerBytes('images.pdf', built.bytes);
            return {
              outputId,
              name: built.name,
              byteLength: built.byteLength,
              pageCount: built.pageCount,
            };
          })(),
        ],
      },
    });
  }

  private async runReadMetadata(
    request: EngineRequest,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    record: JobRecord,
    finish: (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ) => EngineExecution,
    cancelled: () => EngineExecution,
  ): Promise<EngineExecution> {
    if (request.operation !== 'pdf.read_metadata') {
      return finish('failed', {
        error: opError('INVALID_OPTIONS', 'unknown operation'),
      });
    }
    const doc = simulateDocument(request.inputs[0].name, request.inputs[0].bytes);
    const earlyStop = await this.drive(
      record,
      emit,
      cancelled,
      [
        { phase: 'loading', message: 'parsing PDF structure', steps: 2 },
        { phase: 'reading', message: 'reading metadata', steps: 2 },
      ],
      () => {},
    );
    if (earlyStop !== null) {
      return earlyStop;
    }
    // Deterministic stand-ins: the input's stem as title, a fixed date.
    return finish('completed', {
      result: {
        summary: {
          pageCount: doc.pageCount,
          metadata: {
            title: doc.title,
            author: null,
            subject: null,
            keywords: null,
            creator: null,
            producer: 'folio-testbench (simulated)',
            creationDate: {
              year: 2026,
              month: 1,
              day: 2,
              hour: 3,
              minute: 4,
              second: 5,
              tzOffsetMinutes: 330,
            },
            modificationDate: null,
          },
        } satisfies MetadataSummary as ResultSummary,
        outputs: [],
      },
    });
  }

  private async runSetMetadata(
    request: EngineRequest,
    emit: (partial: Omit<EngineEvent, 'jobId' | 'seq' | 'timestampMs' | 'simulated'>) => void,
    record: JobRecord,
    finish: (
      status: EngineExecution['status'],
      outcome: { result?: EngineExecution['result']; error?: EngineErrorData },
    ) => EngineExecution,
    fail: (error: EngineErrorData) => EngineExecution,
    cancelled: () => EngineExecution,
  ): Promise<EngineExecution> {
    if (request.operation !== 'pdf.set_metadata') {
      return fail(opError('INVALID_OPTIONS', 'unknown operation'));
    }
    // Patch validation mirrors the engine: empty set-values are
    // INVALID_INPUT (clearing is what Clear is for).
    const patch = (request.options as MetadataPatchOptions).patch;
    for (const [field, entry] of Object.entries(patch)) {
      if (
        entry !== undefined &&
        entry.op === 'set' &&
        typeof entry.value === 'string' &&
        entry.value.length === 0
      ) {
        emit({ kind: 'log', level: 'error', message: `metadata field ${field} is empty` });
        return fail(
          opError(
            'INVALID_INPUT',
            `metadata field ${field} cannot be set to an empty string (use Clear)`,
            `field=${field}`,
          ),
        );
      }
    }
    const docs = request.inputs.map((input) => simulateDocument(input.name, input.bytes));
    const earlyStop = await this.drive(
      record,
      emit,
      cancelled,
      [
        { phase: 'validating', message: 'validating metadata patch', steps: 2 },
        { phase: 'applying', message: 'applying metadata patch', steps: 2 },
        { phase: 'finalizing', message: 'finalizing output', steps: 2 },
      ],
      () => {},
    );
    if (earlyStop !== null) {
      return earlyStop;
    }
    const built = makeOutput(
      `${docs[0].name.replace(/\.pdf$/i, '')}-metadata.pdf`,
      docs[0].pageCount,
      'metadata',
    );
    const outputId = registerBytes(built.name, built.bytes);
    return finish('completed', {
      result: {
        summary: { pageCount: docs[0].pageCount },
        outputs: [
          {
            outputId,
            name: built.name,
            byteLength: built.byteLength,
            pageCount: built.pageCount,
          },
        ],
      },
    });
  }
}

/**
 * Option validation mirroring the Rust operations: same error codes, same
 * check order (range before duplicates; reorder length rules). The UI only
 * parses syntax; all semantic rules live here (engine side), exactly where
 * the future WASM adapter will enforce the real ones.
 */
function validateTransformOptions(
  operation: EngineRequest['operation'],
  options: EngineRequest['options'],
  pageCounts: number[],
): EngineErrorData | null {
  const outOfRange = (entry: number, page: number, count: number): EngineErrorData =>
    opError(
      'PAGE_OUT_OF_RANGE',
      `entry ${entry} references page ${page}, but the document contains only ${count} pages`,
      `entry=${entry} page=${page} page_count=${count}`,
    );
  const duplicate = (page: number, first: number, duplicateAt: number, count: number) =>
    opError(
      'DUPLICATE_PAGE',
      `page ${page} appears more than once`,
      `page=${page} first_position=${first} duplicate_position=${duplicateAt} page_count=${count}`,
    );

  const checkList = (pages: number[], count: number): EngineErrorData | null => {
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      if (!Number.isInteger(page) || page < 1 || page > count) {
        return outOfRange(i + 1, page, count);
      }
    }
    const seen = new Map<number, number>();
    for (let i = 0; i < pages.length; i += 1) {
      const page = pages[i];
      const first = seen.get(page);
      if (first !== undefined) {
        return duplicate(page, first, i + 1, count);
      }
      seen.set(page, i + 1);
    }
    return null;
  };

  switch (operation) {
    case 'pdf.inspect':
      return null;
    case 'pdf.extract_pages':
    case 'pdf.delete_pages':
    case 'pdf.rotate': {
      const opts = options as PageSelectionOptions & Partial<RotateOptions>;
      if (operation === 'pdf.rotate') {
        const angle = (options as RotateOptions).angleDeg ?? 0;
        if (!Number.isInteger(angle) || ((angle % 90) + 90) % 90 !== 0) {
          return opError(
            'INVALID_INPUT',
            `rotate angle must be a multiple of 90 degrees, got ${angle}`,
            `angle_deg=${angle}`,
          );
        }
      }
      if (operation === 'pdf.delete_pages') {
        const bad = checkList(opts.pages, pageCounts[0]);
        if (bad !== null) {
          return bad;
        }
        if (new Set(opts.pages).size >= pageCounts[0]) {
          return opError(
            'INVALID_INPUT',
            'deleting all pages would produce an empty document',
            `page_count=${pageCounts[0]}`,
          );
        }
        return null;
      }
      return checkListAllowDuplicates(opts.pages, pageCounts[0], outOfRange);
    }
    case 'pdf.reorder': {
      const opts = options as ReorderOptions;
      const count = pageCounts[0];
      if (opts.order.length !== count) {
        return opError(
          'INVALID_INPUT',
          `reorder order has ${opts.order.length} entries but the document has ${count} pages`,
          `entries=${opts.order.length} page_count=${count}`,
        );
      }
      return checkList(opts.order, count);
    }
    case 'pdf.split': {
      const opts = options as SplitOptions;
      if (opts.parts.length === 0) {
        return opError('INVALID_INPUT', 'split plan must contain at least one part');
      }
      for (let p = 0; p < opts.parts.length; p += 1) {
        const part = opts.parts[p];
        if (part.pages.length === 0) {
          return opError('INVALID_INPUT', `part ${p + 1} must contain at least one page`);
        }
        const bad = checkListAllowDuplicates(part.pages, pageCounts[0], outOfRange);
        if (bad !== null) {
          return bad;
        }
      }
      return null;
    }
    case 'pdf.merge': {
      if (pageCounts.length === 0) {
        return opError('INVALID_INPUT', 'merge requires at least one input document');
      }
      return null;
    }
    default:
      return opError('INVALID_OPTIONS', 'unknown operation');
  }
}

/** Range-checked list where repeats are legal (extract/split semantics). */
function checkListAllowDuplicates(
  pages: number[],
  count: number,
  outOfRange: (entry: number, page: number, count: number) => EngineErrorData,
): EngineErrorData | null {
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (!Number.isInteger(page) || page < 1 || page > count) {
      return outOfRange(i + 1, page, count);
    }
  }
  return null;
}

function makeOutput(
  name: string,
  pageCount: number,
  label: string,
  rotations: number[] = [],
): { name: string; bytes: Uint8Array; byteLength: number; pageCount: number } {
  const bytes = makePlaceholderPdf(
    pageCount,
    label,
    Array.from({ length: pageCount }, (_, i) => ({ rotationDeg: rotations[i] ?? 0 })),
  );
  return { name, bytes, byteLength: bytes.length, pageCount };
}

/**
 * Builds the simulated result summaries + output documents. Page-count
 * arithmetic mirrors the real operations (sums, remainders, permutations)
 * so UI logic is exercised against coherent data.
 */
function buildTransformResult(
  request: EngineRequest,
  docs: Array<{ name: string; pageCount: number; pdfVersion: string; title: string | null }>,
): NonNullable<EngineExecution['result']> {
  const takeOutput = (
    name: string,
    pageCount: number,
    label: string,
    rotations: number[] = [],
  ): OutputDocumentRef => {
    const built = makeOutput(name, pageCount, label, rotations);
    const outputId = registerBytes(name, built.bytes);
    return {
      outputId,
      name: built.name,
      byteLength: built.byteLength,
      pageCount: built.pageCount,
    };
  };

  switch (request.operation) {
    case 'pdf.extract_pages': {
      const pages = (request.options as PageSelectionOptions).pages;
      return {
        summary: { pageCount: pages.length },
        outputs: [
          takeOutput(
            `${docs[0].name.replace(/\.pdf$/i, '')}-extracted.pdf`,
            pages.length,
            `extract ${pages.length} pages`,
          ),
        ],
      };
    }
    case 'pdf.split': {
      const parts = (request.options as SplitOptions).parts;
      return {
        summary: {
          inputPageCount: docs[0].pageCount,
          parts: parts.map((part, index) => ({
            name: part.name ?? `part-${index + 1}`,
            pageCount: part.pages.length,
          })),
        },
        outputs: parts.map((part, index) =>
          takeOutput(
            `${docs[0].name.replace(/\.pdf$/i, '')}-part-${part.name ?? index + 1}.pdf`,
            part.pages.length,
            `split part ${index + 1}`,
          ),
        ),
      };
    }
    case 'pdf.reorder': {
      return {
        summary: { pageCount: docs[0].pageCount },
        outputs: [
          takeOutput(
            `${docs[0].name.replace(/\.pdf$/i, '')}-reordered.pdf`,
            docs[0].pageCount,
            'reorder',
          ),
        ],
      };
    }
    case 'pdf.delete_pages': {
      const pages = (request.options as PageSelectionOptions).pages;
      const remaining = docs[0].pageCount - new Set(pages).size;
      return {
        summary: {
          pageCount: remaining,
          inputPageCount: docs[0].pageCount,
          outputPageCount: remaining,
        },
        outputs: [
          takeOutput(`${docs[0].name.replace(/\.pdf$/i, '')}-deleted.pdf`, remaining, 'delete'),
        ],
      };
    }
    case 'pdf.rotate': {
      const opts = request.options as PageSelectionOptions & Partial<RotateOptions>;
      const angle = opts.angleDeg ?? 0;
      const rotations = Array.from({ length: docs[0].pageCount }, (_, i) =>
        opts.pages.includes(i + 1) ? ((angle % 360) + 360) % 360 : 0,
      );
      return {
        summary: { pageCount: docs[0].pageCount },
        outputs: [
          takeOutput(
            `${docs[0].name.replace(/\.pdf$/i, '')}-rotated.pdf`,
            docs[0].pageCount,
            'rotate',
            rotations,
          ),
        ],
      };
    }
    case 'pdf.merge': {
      const total = docs.reduce((sum, doc) => sum + doc.pageCount, 0);
      return {
        summary: {
          inputDocumentCount: docs.length,
          inputPageCount: total,
          outputPageCount: total,
        },
        outputs: [takeOutput('merged.pdf', total, 'merge')],
      };
    }
    default:
      return { summary: { pageCount: 0 }, outputs: [] };
  }
}
