/**
 * scanic scanner core (D34/D35/D46): ML-only worker client with `redetect`,
 * the capture queue hook, the detector policy (ML only — warm preload at
 * scanner open), and the shared corner/protocol types. The corner-editor UI
 * consumes this barrel.
 *
 * No-regret ML pipeline (2026-10-11): mount-lifetime retained detect client
 * (`getRetainedDetectClient` / `releaseRetainedDetectClient` — factory +
 * release names FROZEN for the VF lane), K-lane pool staffing
 * (`acquireDetectionPool`, `detectionLaneClient`), measure-only detect
 * instrumentation (`ScanicDetectInstrumentation`, frozen field names),
 * per-item queue spans (`onItemSpan`, `createReviewSpanCollector`), and the
 * read-only EXIF probe (`probeExifOrientation`). Protocol stays v1
 * (additive fields only); queue signature unchanged (additive opts only).
 */

export {
  ScanicClient,
  ScanicClientError,
  acquireDetectionPool,
  detectionLaneClient,
  getRetainedDetectClient,
  redetect,
  releaseRetainedDetectClient,
} from './scanicClient';
export type {
  DetectionPool,
  DetectionPoolOptions,
  ScanicClientDetectOptions,
  ScanicClientErrorCode,
  ScanicClientOptions,
} from './scanicClient';
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
  ML_MODEL_INPUT_SIZE,
  defaultDetector,
  detectorForAttempt,
  mlDetectorWarmState,
  resolveDetectionWorkerCount,
  warmMlDetector,
} from './detectorPolicy';
export type { DetectionWorkerOptions, MlWarmState } from './detectorPolicy';
export { createReviewSpanCollector, runReviewDetectionQueue } from './reviewDetection';
export type { ReviewDetectionQueueOptions, ReviewDetectionSpan } from './reviewDetection';
export {
  EXIF_PROBE_SLICE_BYTES,
  probeExifOrientation,
  readExifOrientationBytes,
} from './exifProbe';
export type { ExifProbeResult } from './exifProbe';
export {
  SCANIC_CORNER_KEYS,
  SCANIC_WORKER_PROTOCOL_VERSION,
  isScanicDetectorKind,
  isValidScanicCorners,
  validateScanicCorners,
} from './scanicProtocol';
export type {
  ScanicCorners,
  ScanicDetectInstrumentation,
  ScanicDetectionResult,
  ScanicDetectorKind,
  ScanicPoint,
} from './scanicProtocol';
