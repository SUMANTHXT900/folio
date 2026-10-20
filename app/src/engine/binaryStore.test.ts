/**
 * binaryStore accounting tests (audit §3 Tests gap).
 *
 * `storedBytes()` is the accounting basis for a future cap: every
 * register/put/release/clear updates it, double-release is safe, and
 * stale-id reads never affect it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __clearBinaryStore,
  byteLength,
  copyBytes,
  getBytes,
  putBytes,
  registerBytes,
  releaseBytes,
  storedBytes,
  storedCount,
} from './binaryStore';

beforeEach(() => {
  __clearBinaryStore();
});

describe('binaryStore byte accounting', () => {
  it('starts empty', () => {
    expect(storedBytes()).toBe(0);
    expect(storedCount()).toBe(0);
  });

  it('register adds bytes to the total', () => {
    const a = registerBytes('a.pdf', new Uint8Array([1, 2, 3, 4]));
    expect(storedBytes()).toBe(4);
    const b = registerBytes('b.pdf', new Uint8Array([5, 6]));
    expect(storedBytes()).toBe(6);
    expect(storedCount()).toBe(2);
    expect(byteLength(a)).toBe(4);
    expect(byteLength(b)).toBe(2);
  });

  it('release subtracts bytes and is idempotent (double-release safe)', () => {
    const a = registerBytes('a.pdf', new Uint8Array([1, 2, 3, 4]));
    const b = registerBytes('b.pdf', new Uint8Array([5, 6]));
    expect(storedBytes()).toBe(6);
    releaseBytes(a);
    expect(storedBytes()).toBe(2);
    expect(storedCount()).toBe(1);
    // Second release of the same id is a no-op, never negative.
    releaseBytes(a);
    expect(storedBytes()).toBe(2);
    expect(storedCount()).toBe(1);
    releaseBytes(b);
    expect(storedBytes()).toBe(0);
    expect(storedCount()).toBe(0);
  });

  it('stale-id reads return empty without affecting accounting', () => {
    const a = registerBytes('a.pdf', new Uint8Array([1, 2]));
    expect(storedBytes()).toBe(2);
    expect(getBytes('bin-999')).toBeUndefined();
    expect(byteLength('bin-999')).toBe(0);
    expect(copyBytes('bin-999')).toBeUndefined();
    // Releasing an unknown id is safe and leaves the total alone.
    releaseBytes('bin-999');
    expect(storedBytes()).toBe(2);
    expect(storedCount()).toBe(1);
    expect(getBytes(a)).toBeDefined();
  });

  it('putBytes under a caller id adds, and overwrite replaces (no double-count)', () => {
    putBytes('input-1', 'a.pdf', new Uint8Array([1, 2, 3]));
    expect(storedBytes()).toBe(3);
    expect(storedCount()).toBe(1);
    // Overwrite the same id with a larger buffer: total is replaced, not summed.
    putBytes('input-1', 'a.pdf', new Uint8Array([1, 2, 3, 4, 5]));
    expect(storedBytes()).toBe(5);
    expect(storedCount()).toBe(1);
    // Second caller id adds on top.
    putBytes('input-2', 'b.pdf', new Uint8Array([9]));
    expect(storedBytes()).toBe(6);
    expect(storedCount()).toBe(2);
    releaseBytes('input-1');
    expect(storedBytes()).toBe(1);
    releaseBytes('input-2');
    expect(storedBytes()).toBe(0);
  });

  it('clear resets accounting to zero', () => {
    registerBytes('a.pdf', new Uint8Array([1, 2, 3]));
    putBytes('input-1', 'b.pdf', new Uint8Array([4, 5]));
    expect(storedBytes()).toBe(5);
    __clearBinaryStore();
    expect(storedBytes()).toBe(0);
    expect(storedCount()).toBe(0);
  });
});
