import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, sanitizeSettings } from '@/storage/settings';
import { deleteClip, getClip, saveClip } from '@/storage/audioStorage';
import { encodeWavMono16 } from '@/audio/clipProcessor';

describe('sanitizeSettings', () => {
  it('returns defaults for garbage input', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('nope')).toEqual(DEFAULT_SETTINGS);
  });

  it('clamps duration to 5..10 and volume to 0..1', () => {
    expect(sanitizeSettings({ durationSec: 99 }).durationSec).toBe(10);
    expect(sanitizeSettings({ durationSec: 1 }).durationSec).toBe(5);
    expect(sanitizeSettings({ volume: 4 }).volume).toBe(1);
    expect(sanitizeSettings({ volume: -1 }).volume).toBe(0);
    expect(sanitizeSettings({ durationSec: NaN }).durationSec).toBe(DEFAULT_SETTINGS.durationSec);
  });

  it('keeps the start offset inside the clip', () => {
    const s = sanitizeSettings({ clipLengthSec: 20, startOffsetSec: 100 });
    expect(s.startOffsetSec).toBe(15);
    expect(sanitizeSettings({ clipLengthSec: 0, startOffsetSec: 3 }).startOffsetSec).toBe(0);
  });

  it('only accepts real booleans and strings', () => {
    const s = sanitizeSettings({ enabled: 'yes', displayName: 42, monitorLocally: 1 });
    expect(s.enabled).toBe(false);
    expect(s.displayName).toBe('');
    expect(s.monitorLocally).toBe(false);
  });
});

describe('audioStorage (IndexedDB)', () => {
  it('stores, reads and deletes the clip', async () => {
    expect(await getClip()).toBeNull();
    const wav = encodeWavMono16(new Float32Array(48000));
    await saveClip({ id: 'abc', name: 'theme.mp3', wav, lengthSec: 1, createdAt: 1 });
    const got = await getClip();
    expect(got?.id).toBe('abc');
    expect(got?.name).toBe('theme.mp3');
    expect(got?.wav.byteLength).toBe(wav.byteLength);
    await deleteClip();
    expect(await getClip()).toBeNull();
  });

  it('replacing the clip overwrites the previous one', async () => {
    const wav = encodeWavMono16(new Float32Array(48000));
    await saveClip({ id: 'one', name: 'a', wav, lengthSec: 1, createdAt: 1 });
    await saveClip({ id: 'two', name: 'b', wav, lengthSec: 1, createdAt: 2 });
    expect((await getClip())?.id).toBe('two');
  });
});
