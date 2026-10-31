import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, saveSettings, type Settings } from '@/storage/settings';
import { deleteClip, getClip, saveClip, type StoredClip } from '@/storage/audioStorage';
import { normalizeFileToWav } from '@/audio/clipProcessor';
import { STATUS_STORAGE_KEY, type TabCommand, type TabStatus } from '@/types/messages';

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (alive) {
        setSettings(s);
        setLoaded(true);
      }
    });
    const off = onSettingsChanged((s) => alive && setSettings(s));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch })); // optimistic, then persisted + sanitised
    void saveSettings(patch).then(setSettings);
  }, []);

  return { settings, loaded, update };
}

export function useClip(settings: Settings, update: (patch: Partial<Settings>) => void) {
  const [clip, setClip] = useState<StoredClip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clipId = settings.clipId;

  useEffect(() => {
    let alive = true;
    if (!clipId) {
      setClip(null);
      return;
    }
    void getClip()
      .then((c) => alive && setClip(c && c.id === clipId ? c : null))
      .catch(() => alive && setClip(null));
    return () => {
      alive = false;
    };
  }, [clipId]);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setBusy(true);
      try {
        if (!/\.(mp3|wav)$/i.test(file.name) && !/^audio\/(mpeg|mp3|wav|x-wav|wave)$/i.test(file.type)) {
          throw new Error('Please choose an MP3 or WAV file.');
        }
        const { wav, lengthSec } = await normalizeFileToWav(file);
        const stored: StoredClip = {
          id: crypto.randomUUID(),
          name: file.name,
          wav,
          lengthSec,
          createdAt: Date.now(),
        };
        await saveClip(stored);
        setClip(stored);
        update({ clipId: stored.id, clipName: stored.name, clipLengthSec: lengthSec, startOffsetSec: 0 });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed.');
      } finally {
        setBusy(false);
      }
    },
    [update],
  );

  const remove = useCallback(async () => {
    await deleteClip();
    setClip(null);
    update({ clipId: null, clipName: null, clipLengthSec: 0, startOffsetSec: 0, enabled: false });
  }, [update]);

  return { clip, error, busy, upload, remove, clearError: () => setError(null) };
}

/** Live status of the most recently updated Google Meet tab, or null when none reported. */
export function useMeetStatus() {
  const [status, setStatus] = useState<TabStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const pick = (map: Record<string, TabStatus> | undefined) => {
      const all = Object.values(map ?? {});
      all.sort((a, b) => {
        const rank = (s: TabStatus) => (s.meetingState === 'joined' ? 1 : 0);
        return rank(b) - rank(a) || b.updatedAt - a.updatedAt;
      });
      return all[0] ?? null;
    };
    void chrome.storage.session.get(STATUS_STORAGE_KEY).then((got) => alive && setStatus(pick(got[STATUS_STORAGE_KEY])));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[STATUS_STORAGE_KEY]) setStatus(pick(changes[STATUS_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const send = useCallback(
    async (cmd: TabCommand): Promise<boolean> => {
      if (!status) return false;
      try {
        await chrome.tabs.sendMessage(status.tabId, cmd);
        return true;
      } catch {
        return false; // tab closed or content script not present
      }
    },
    [status],
  );

  return { status, send };
}
