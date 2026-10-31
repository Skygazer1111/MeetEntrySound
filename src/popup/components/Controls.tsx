import { MAX_DURATION_SEC, MIN_DURATION_SEC } from '@/storage/settings';

export function AutoPlayToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`switch${disabled ? ' disabled' : ''}`} title={disabled ? 'Upload a clip first' : undefined}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      <span className="switch-label">{checked ? 'On' : 'Off'}</span>
    </label>
  );
}

export function DurationSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const options: number[] = [];
  for (let s = MIN_DURATION_SEC; s <= MAX_DURATION_SEC; s++) options.push(s);
  return (
    <div className="segmented" role="radiogroup" aria-label="Entrance duration in seconds">
      {options.map((s) => (
        <button
          key={s}
          type="button"
          role="radio"
          aria-checked={Math.round(value) === s}
          className={Math.round(value) === s ? 'active' : ''}
          onClick={() => onChange(s)}
        >
          {s}s
        </button>
      ))}
    </div>
  );
}

export function VolumeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="slider-row">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" />
      </svg>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        aria-label="Volume"
        style={{ ['--fill' as string]: `${Math.round(value * 100)}%` }}
      />
      <span className="slider-value">{Math.round(value * 100)}%</span>
    </div>
  );
}
