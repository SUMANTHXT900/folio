/**
 * scanic scanner core (D34/D35/D46): ML-only worker client with `redetect`,
 * the capture queue hook, the detector policy (ML only — warm preload at
 * scanner open), and the shared corner/protocol types. The corner-editor UI
 * consumes this barrel.
 */

export { ScanicClient, ScanicClientError, redetect } from './scanicClient';
export type { ScanicClientErrorCode, ScanicClientOptions } from './scanicClient';
export { useScanicProcessor } from './useScanicProcessor';
export type {
  ScanicEntry,
  ScanicEntryPhase,
  ScanicProcessor,
  ScanicProcessorOptions,
} from './useScanicProcessor';
export {
  DEFAULT_DETECTOR,
  ML_ASSET_BASE_URL,
  ML_DETECTOR_OPTIONS,
  defaultDetector,
  detectorForAttempt,
  mlDetectorWarmState,
  warmMlDetector,
} from './detectorPolicy';
export type { MlWarmState } from './detectorPolicy';
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
