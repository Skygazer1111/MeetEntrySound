// User settings, persisted in chrome.storage.local. Nothing here ever leaves the device.

export interface Settings {
  /** Master switch for automatic entrance music. */
  enabled: boolean;
  /** Profile label (display name used in Meet). Informational only. */
  displayName: string;
  /** Optional Gmail label. Informational only; never sent anywhere, no Google OAuth involved. */
  email: string;
  /** Playback volume, 0..1. */
  volume: number;
  /** Entrance length in seconds, 5..10. */
  durationSec: number;
  /** Where in the stored clip playback starts. */
  startOffsetSec: number;
  /** Minimum seconds between two automatic plays (guards against rejoin loops). */
  cooldownSec: number;
  /** Fade in/out length in milliseconds. */
  fadeMs: number;
  /** Also play the clip through your own speakers while it is sent. May cause echo without headphones. */
  monitorLocally: boolean;
  /**
   * Briefly switch Meet's "Studio sound" / noise cancellation off while the clip plays, then back on.
   * Those filters strip anything that is not speech, which wrecks music.
   */
  autoDisableStudioSound: boolean;
  /** Metadata about the stored clip (the audio itself lives in IndexedDB). */
  clipId: string | null;
  clipName: string | null;
  clipLengthSec: number;
}

export const MIN_DURATION_SEC = 5;
export const MAX_DURATION_SEC = 10;

export const DEFAULT_SETTINGS: Settings = {
  enabled: false,
  displayName: '',
  email: '',
  volume: 0.8,
  durationSec: 7,
  startOffsetSec: 0,
  cooldownSec: 30,
  fadeMs: 400,
  monitorLocally: false,
  autoDisableStudioSound: true,
  clipId: null,
  clipName: null,
  clipLengthSec: 0,
};

const SETTINGS_KEY = 'meetentry.settings';

const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** Coerces arbitrary stored data into a valid Settings object (missing/invalid fields fall back to defaults). */
export function sanitizeSettings(raw: unknown): Settings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_SETTINGS;
  const clipLengthSec = num(r.clipLengthSec, 0, 0, 3600);
  const maxOffset = Math.max(0, clipLengthSec - MIN_DURATION_SEC);
  return {
    enabled: r.enabled === true,
    displayName: str(r.displayName, 80),
    email: str(r.email, 120),
    volume: num(r.volume, d.volume, 0, 1),
    durationSec: Math.round(num(r.durationSec, d.durationSec, MIN_DURATION_SEC, MAX_DURATION_SEC) * 10) / 10,
    startOffsetSec: num(r.startOffsetSec, 0, 0, maxOffset),
    cooldownSec: num(r.cooldownSec, d.cooldownSec, 0, 600),
    fadeMs: num(r.fadeMs, d.fadeMs, 0, 1500),
    monitorLocally: r.monitorLocally === true,
    autoDisableStudioSound: typeof r.autoDisableStudioSound === 'boolean' ? r.autoDisableStudioSound : d.autoDisableStudioSound,
    clipId: typeof r.clipId === 'string' && r.clipId ? r.clipId.slice(0, 100) : null,
    clipName: typeof r.clipName === 'string' ? r.clipName.slice(0, 200) : null,
    clipLengthSec,
  };
}

export async function loadSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return sanitizeSettings(got[SETTINGS_KEY]);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = sanitizeSettings({ ...(await loadSettings()), ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** Subscribes to settings changes made from any extension context. Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(sanitizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
