/**
 * Scan protocol tests: versioning, framing guards, and the
 * success/fallback/error distinction the UI branches on.
 */
import { describe, expect, it } from 'vitest';
import { SCAN_PROTOCOL_VERSION, parseScanMessage, type ScanRewrapRequest } from './scanProtocol';

describe('scanProtocol', () => {
  it('pins the protocol version', () => {
    // v2 added the `detectOnly` process flag + `detected` results.
    expect(SCAN_PROTOCOL_VERSION).toBe(2);
  });

  it('accepts well-formed messages', () => {
    expect(parseScanMessage({ protocol: 2, kind: 'ready' })).toEqual({
      protocol: 2,
      kind: 'ready',
    });
    expect(
      parseScanMessage({ protocol: 2, kind: 'status', jobId: 'scan-1', phase: 'processing' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 2, kind: 'result', jobId: 'scan-1', resultJson: '{}' }),
    ).not.toBeNull();
    expect(
      parseScanMessage({ protocol: 2, kind: 'fatal', jobId: null, message: 'boom' }),
    ).not.toBeNull();
  });

  it('rejects malformed framing without throwing', () => {
    expect(parseScanMessage(null)).toBeNull();
    expect(parseScanMessage('ready')).toBeNull();
    expect(parseScanMessage({ protocol: 999, kind: 'ready' })).toBeNull();
    expect(parseScanMessage({ protocol: 1, kind: 'ready' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'nope' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'result', jobId: 'scan-1' })).toBeNull();
    expect(parseScanMessage({ protocol: 2, kind: 'fatal', jobId: null })).toBeNull();
  });

  it('carries rewrap additively under the same v2', () => {
    // No version bump, no new worker→main shapes: rewrap reuses the
    // existing result envelope (status `processed` + output bytes).
    const rewrap: ScanRewrapRequest = {
      protocol: SCAN_PROTOCOL_VERSION,
      kind: 'rewrap',
      jobId: 'scan-9',
      bytes: new ArrayBuffer(3),
      quad: [
        { x: 10, y: 10 },
        { x: 630, y: 10 },
        { x: 630, y: 790 },
        { x: 10, y: 790 },
      ],
    };
    expect(rewrap.protocol).toBe(2);
    expect(rewrap.kind).toBe('rewrap');
    expect(rewrap.quad).toHaveLength(4);
  });
});
