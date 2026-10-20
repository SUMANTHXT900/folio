// @vitest-environment node
/**
 * engine.worker input-validation tests (no WASM, no browser).
 *
 * The worker module runs at import (it boots the WASM engine
 * asynchronously), so these tests install a `self` double BEFORE the
 * dynamic import and drive the message handler directly — the same shape
 * as the imageEncode worker tests. This pins the per-field `inputs[]`
 * validation: malformed entries fail fast with a bounded `fatal` carrying
 * the cause (never silence → never an adapter hang), while unroutable or
 * wrong-version framing is ignored without replying.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

interface Posted {
  message: unknown;
  transfer?: unknown;
}

interface SelfDouble {
  posted: Posted[];
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: unknown) => void;
}

let scope: SelfDouble;
let priorSelf: unknown;

function send(data: unknown): void {
  scope.onmessage?.({ data } as MessageEvent);
}

/** Fatals for real jobs (the boot-time init-fatal has an empty job id). */
function jobFatals(): Array<Record<string, unknown>> {
  return scope.posted
    .map((p) => p.message as Record<string, unknown>)
    .filter((m) => m['kind'] === 'fatal' && m['clientJobId'] !== '');
}

function executeMessage(inputs: unknown): Record<string, unknown> {
  return {
    protocol: 1,
    kind: 'execute',
    clientJobId: 'wasm-1',
    operation: 'pdf.merge',
    inputs,
    options: {},
  };
}

beforeAll(async () => {
  priorSelf = (globalThis as unknown as Record<string, unknown>)['self'];
  const double: SelfDouble = {
    posted: [],
    onmessage: null,
    postMessage(message: unknown, transfer?: unknown) {
      double.posted.push({ message, transfer });
    },
  };
  scope = double;
  (globalThis as unknown as Record<string, unknown>)['self'] = double;
  await import('./engine.worker');
});

afterAll(() => {
  (globalThis as unknown as Record<string, unknown>)['self'] = priorSelf;
});

beforeEach(() => {
  scope.posted.length = 0;
});

describe('engine.worker input validation', () => {
  it('rejects a non-array inputs with a bounded fatal carrying the cause', () => {
    send(executeMessage('not-an-array'));
    const fatals = jobFatals();
    expect(fatals).toHaveLength(1);
    expect(fatals[0]).toMatchObject({ protocol: 1, kind: 'fatal', clientJobId: 'wasm-1' });
    expect(String(fatals[0]?.['message'])).toContain('inputs must be an array');
    // Operation context, not a bare failure: the adapter can attribute it.
    expect(String(fatals[0]?.['message'])).toContain('pdf.merge');
  });

  it('rejects entries with an empty name, naming the entry index', () => {
    send(executeMessage([{ name: '', buffer: new ArrayBuffer(8) }]));
    const fatals = jobFatals();
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0]?.['message'])).toContain('inputs[#1]');
    expect(String(fatals[0]?.['message'])).toContain('name=');
  });

  it('rejects entries whose buffer is not a transferred ArrayBuffer', () => {
    send(executeMessage([{ name: 'a.pdf', buffer: new Uint8Array([1, 2, 3]) }]));
    const fatals = jobFatals();
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0]?.['message'])).toContain('inputs[#1]');
    expect(String(fatals[0]?.['message'])).toContain('ArrayBuffer');
    expect(String(fatals[0]?.['message'])).toContain('Uint8Array');
  });

  it('ignores unroutable jobs without replying', () => {
    // No string clientJobId: nothing to blame, so silence (a fatal here
    // would arrive jobless and destroy the worker for innocent jobs).
    send({
      protocol: 1,
      kind: 'execute',
      operation: 'pdf.merge',
      inputs: 'not-an-array',
      options: {},
    });
    send(null);
    send('execute');
    send({ protocol: 999, kind: 'execute', clientJobId: 'wasm-1', operation: 'x', inputs: [] });
    expect(scope.posted).toHaveLength(0);
  });
});
