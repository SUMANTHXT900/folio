import { useState } from 'react';
import type { CameraRange } from './cameraControls';

interface Props {
  zoomRange?: CameraRange;
  exposureRange?: CameraRange;
  zoom: number;
  exposure: number;
  focus: boolean;
  disabled: boolean;
  onZoom: (value: number) => void;
  onExposure: (value: number) => void;
  onFocus: () => void;
}

/** Quiet camera tools; only real, capability-backed controls enter the finder. */
export default function FinderControls(props: Props) {
  const [panel, setPanel] = useState<'zoom' | 'exposure' | null>(null);
  const { zoomRange, exposureRange, focus, disabled } = props;
  if (!zoomRange && !exposureRange && !focus) return null;
  const button =
    'min-h-[44px] min-w-[44px] rounded-full px-3 text-xs font-medium disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brass-400';
  const range = panel === 'zoom' ? zoomRange : panel === 'exposure' ? exposureRange : undefined;
  return (
    <div data-camera-controls className="mx-auto w-full max-w-sm text-paper-50">
      {range && (
        <div className="mb-2 flex min-h-[44px] items-center gap-3 rounded-xl bg-ink-950/90 px-3">
          <span className="text-xs">{panel === 'zoom' ? 'Wide' : '−'}</span>
          <input
            type="range"
            aria-label={panel === 'zoom' ? 'Camera zoom' : 'Camera brightness'}
            min={range.min}
            max={range.max}
            step={range.step}
            value={panel === 'zoom' ? props.zoom : props.exposure}
            disabled={disabled}
            className="h-11 min-w-0 flex-1 accent-brass-400"
            onChange={(event) =>
              (panel === 'zoom' ? props.onZoom : props.onExposure)(Number(event.target.value))
            }
          />
          <span className="text-xs">{panel === 'zoom' ? 'Near' : '+'}</span>
        </div>
      )}
      <div className="mx-auto flex w-fit items-center justify-center rounded-full border border-paper-50/20 bg-ink-950/90 p-0.5">
        {zoomRange && (
          <>
            <button
              type="button"
              className={button}
              disabled={disabled}
              onClick={() => props.onZoom(zoomRange.min)}
              aria-label="Widest camera view"
            >
              Wide
            </button>
            <button
              type="button"
              className={button}
              disabled={disabled}
              aria-expanded={panel === 'zoom'}
              aria-label="Adjust camera zoom"
              onClick={() => setPanel(panel === 'zoom' ? null : 'zoom')}
            >
              Zoom {props.zoom.toFixed(1)}
            </button>
          </>
        )}
        {exposureRange && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            aria-expanded={panel === 'exposure'}
            aria-label="Adjust camera brightness"
            onClick={() => setPanel(panel === 'exposure' ? null : 'exposure')}
          >
            Light {props.exposure > 0 ? '+' : ''}
            {props.exposure.toFixed(1)}
          </button>
        )}
        {focus && (
          <button
            type="button"
            className={button}
            disabled={disabled}
            aria-label="Refocus camera"
            onClick={props.onFocus}
          >
            Autofocus
          </button>
        )}
      </div>
    </div>
  );
}
