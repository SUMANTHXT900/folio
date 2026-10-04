/**
 * scanic scanner core (D34): worker client, capture queue hook, and the
 * shared corner/protocol types. The corner-editor UI consumes this barrel.
 */

export { ScanicClient, ScanicClientError } from './scanicClient';
export type { ScanicClientErrorCode, ScanicClientOptions } from './scanicClient';
export { useScanicProcessor } from './useScanicProcessor';
export type {
  ScanicEntry,
  ScanicEntryPhase,
  ScanicProcessor,
  ScanicProcessorOptions,
} from './useScanicProcessor';
export {
  SCANIC_CORNER_KEYS,
  SCANIC_WORKER_PROTOCOL_VERSION,
  isScanicDetectorKind,
  isValidScanicCorners,
  validateScanicCorners,
} from './scanicProtocol';
export type {
  ScanicCorners,
  ScanicDetectionResult,
  ScanicDetectorKind,
  ScanicPoint,
} from './scanicProtocol';
