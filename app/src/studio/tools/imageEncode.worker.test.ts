/**
 * Encode worker protocol/hardening tests (no canvas, no OffscreenCanvas).
 *
 * The worker module runs at import (it posts `ready` synchronously), so
 * these tests install a `self` double BEFORE the dynamic import and drive
 * the message handler directly: versioned framing, bounded error replies
 * for malformed jobs (never silence → never a client timeout), bitmap
 * release on rejected jobs, and operation context in fatal paths. The
 * pixel routine itself is covered by the import-path tests, never here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
let protocolVersion = 0;
let bootMessages: Posted[] = [];

function send(data: unknown): void {
  scope.onmessage?.({ data } as MessageEvent);
}

function resultMessages(): Array<Record<string, unknown>> {
  return scope.posted
    .map((p) => p.message as Record<string, unknown>)
    .filter((m) => m['kind'] === 'result');
}

function fakeBitmap() {
  return { close: vi.fn() } as unknown as ImageBitmap;
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
  const mod = await import('./imageEncode.worker');
  protocolVersion = mod.ENCODE_PROTOCOL_VERSION as number;
  bootMessages = [...double.posted];
});

afterAll(() => {
  (globalThis as unknown as Record<string, unknown>)['self'] = priorSelf;
});

beforeEach(() => {
  scope.posted.length = 0;
});

describe('imageEncode.worker protocol', () => {
  it('pins the protocol version', () => {
    expect(protocolVersion).toBe(1);
  });

  it('announces ready with the protocol version at boot', () => {
    expect(bootMessages).toHaveLength(1);
    const ready = bootMessages[0]?.message as Record<string, unknown>;
    expect(ready['protocol']).toBe(1);
    expect(ready['kind']).toBe('ready');
    expect(typeof ready['offscreen']).toBe('boolean');
  });

  it('answers malformed jobs with a bounded error and releases the bitmap', () => {
    const bitmap = fakeBitmap();
    send({
      kind: 'encode',
      id: 7,
      bitmap,
      width: 0,
      height: 10,
      quality: 0.92,
      flipHorizontal: false,
    });
    const msgs = resultMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ protocol: 1, kind: 'result', id: 7, ok: false });
    // Operation context, not a bare failure: the client can attribute it.
    expect(String(msgs[0]?.['message'])).toContain('Malformed encode job');
    expect(String(msgs[0]?.['message'])).toContain('id=7');
    // The transferred bitmap was consumed — never leaked, never timed out.
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('rejects version mismatches with a bounded error', () => {
    const bitmap = fakeBitmap();
    send({
      protocol: 999,
      kind: 'encode',
      id: 3,
      bitmap,
      width: 40,
      height: 30,
      quality: 0.92,
      flipHorizontal: false,
    });
    const msgs = resultMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ protocol: 1, kind: 'result', id: 3, ok: false });
    expect(String(msgs[0]?.['message'])).toContain('999');
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('carries operation context on fatal encode failures', async () => {
    // Well-formed framing, unusable runtime (no OffscreenCanvas under
    // jsdom): the async path must still answer `ok:false` with the job's
    // dimensions, never silence.
    send({
      protocol: 1,
      kind: 'encode',
      id: 11,
      bitmap: fakeBitmap(),
      width: 40,
      height: 30,
      quality: 0.92,
      flipHorizontal: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const msgs = resultMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ protocol: 1, kind: 'result', id: 11, ok: false });
    expect(String(msgs[0]?.['message'])).toContain('40x30');
  });

  it('ignores unroutable messages without replying', () => {
    send(null);
    send('encode');
    send({ kind: 'nope' });
    // No numeric `id`: uncorrelatable, so silence is the only option.
    send({ kind: 'encode', width: 40, height: 30 });
    expect(scope.posted).toHaveLength(0);
  });
});
