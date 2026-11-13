/** Browser camera values are hardware units, never promised optical multipliers. */
export interface CameraRange {
  min: number;
  max: number;
  step: number;
}

export function cameraRange(value: unknown): CameraRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { min, max, step } = value as Partial<CameraRange>;
  if (
    typeof min !== 'number' ||
    typeof max !== 'number' ||
    !Number.isFinite(min) ||
    !Number.isFinite(max) ||
    max <= min
  )
    return undefined;
  return {
    min,
    max,
    step: typeof step === 'number' && Number.isFinite(step) && step > 0 ? step : (max - min) / 100,
  };
}

export function clampCameraValue(value: number, range: CameraRange): number {
  const snapped = range.min + Math.round((value - range.min) / range.step) * range.step;
  return Number(Math.max(range.min, Math.min(range.max, snapped)).toFixed(6));
}

const queues = new WeakMap<MediaStreamTrack, Promise<void>>();

/** Serialize per track; applyConstraints replaces rather than patches constraints. */
export function applyTrackControl(
  track: MediaStreamTrack,
  change: Record<string, unknown>,
): Promise<void> {
  const work = (queues.get(track) ?? Promise.resolve()).then(async () => {
    const previous = track.getConstraints?.() ?? {};
    const controls = Object.assign({}, ...(previous.advanced ?? []), change);
    await track.applyConstraints({
      ...previous,
      advanced: [controls as MediaTrackConstraintSet],
    });
  });
  queues.set(
    track,
    work.catch(() => undefined),
  );
  return work;
}
