// Service worker: the only context (besides the popup/options pages) that reads IndexedDB.
//  - Serves the trimmed entrance clip to Meet tabs on request.
//  - Keeps a per-tab status map in chrome.storage.session so the popup can show live state
//    without needing the "tabs" permission.

import { getClip } from '@/storage/audioStorage';
import { arrayBufferToBase64, sliceWav } from '@/audio/clipProcessor';
import {
  parseContentToWorker,
  STATUS_STORAGE_KEY,
  type GetClipResponse,
  type TabStatus,
} from '@/types/messages';

const MEET_ORIGIN = 'https://meet.google.com/';

let statusQueue: Promise<void> = Promise.resolve();

function updateStatuses(mutate: (map: Record<string, TabStatus>) => void): Promise<void> {
  statusQueue = statusQueue
    .then(async () => {
      const got = await chrome.storage.session.get(STATUS_STORAGE_KEY);
      const map = (got[STATUS_STORAGE_KEY] ?? {}) as Record<string, TabStatus>;
      mutate(map);
      await chrome.storage.session.set({ [STATUS_STORAGE_KEY]: map });
    })
    .catch(() => undefined);
  return statusQueue;
}

async function handleGetClip(clipId: string, startOffsetSec: number, durationSec: number): Promise<GetClipResponse> {
  try {
    const clip = await getClip();
    if (!clip || clip.id !== clipId) return { ok: false, error: 'No matching clip stored.' };
    const duration = Math.min(10, Math.max(1, durationSec));
    const start = Math.min(Math.max(0, startOffsetSec), Math.max(0, clip.lengthSec - 1));
    const wav = sliceWav(clip.wav, start, duration);
    return { ok: true, clipId, wavBase64: arrayBufferToBase64(wav) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed to read clip.' };
  }
}

chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
  // Only accept messages from our own content scripts running on Google Meet.
  if (sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab?.id;
  if (tabId === undefined || !(sender.tab?.url ?? sender.url ?? '').startsWith(MEET_ORIGIN)) return false;
  const msg = parseContentToWorker(raw);
  if (!msg) return false;

  if (msg.t === 'status') {
    const status: TabStatus = { ...msg.status, tabId, updatedAt: Date.now() };
    void updateStatuses((map) => {
      map[String(tabId)] = status;
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  void handleGetClip(msg.clipId, msg.startOffsetSec, msg.durationSec).then(sendResponse);
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateStatuses((map) => {
    delete map[String(tabId)];
  });
});

// A full page load replaces the content script; drop the stale status (the new one re-reports).
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  void updateStatuses((map) => {
    delete map[String(tabId)];
  });
});
