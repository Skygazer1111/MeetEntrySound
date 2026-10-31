// Isolated-world content script: owns meeting detection, settings, the clip hand-off to the
// page-context script, and status reporting. It holds no audio logic itself.

import { base64ToArrayBuffer } from '@/audio/clipProcessor';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChanged, type Settings } from '@/storage/settings';
import type { BridgeEvent, PlayFailReason, StopReason } from '@/types/bridge';
import {
  parseTabCommand,
  type GetClipResponse,
  type LogEntry,
  type PeerSummary,
  type PlaybackPhase,
  type RoutingInfo,
  type TabStatus,
} from '@/types/messages';
import { BridgeClient } from './bridgeClient';
import { MeetDetector, parseMeetCode, readDomSignals } from './meetDetector';
import { MeetingStateMachine, type Transition } from './meetingState';
import { showToast } from './toast';

const LAST_AUTO_PLAY_KEY = 'meetentry:lastAutoPlay';
const NO_PEERS: PeerSummary = { count: 0, connected: false, audioSender: false, micMuted: null };

class EntryController {
  private settings: Settings = DEFAULT_SETTINGS;
  private settingsLoaded = false;
  private machine = new MeetingStateMachine();
  private transition: Transition | null = null;
  private peers: PeerSummary = NO_PEERS;
  private playback: PlaybackPhase = 'idle';
  /** Result of the last real playback attempt; null means "derive from peer state". */
  private routingResult: RoutingInfo | null = null;
  private lastEvent: LogEntry | null = null;
  private debug: TabStatus['debug'];

  private bridge = new BridgeClient(
    (e) => this.onBridgeEvent(e),
    () => {
      this.log('info', 'Connected to the page audio hook.');
      void this.ensureClip();
      this.scheduleTick();
    },
  );
  private detector = new MeetDetector(() => this.tick(true));

  private loadedClipKey: string | null = null;
  private clipLoading: Promise<boolean> | null = null;
  private clipWaiter: { key: string; resolve: (ok: boolean) => void } | null = null;

  private requestId = 0;
  private pendingPlays = new Map<number, 'auto' | 'manual'>();
  /** Last entry we already handled, so one entry can only ever trigger one automatic play. */
  private handledEntryId = 0;

  private publishTimer: number | undefined;
  private tickTimer: number | undefined;
  private lastPublished = '';
  private dead = false;

  async start(): Promise<void> {
    this.bridge.connect();
    this.detector.start();
    window.setInterval(() => this.tick(true), 500);
    window.addEventListener('pagehide', () => {
      this.bridge.send({ type: 'stop', reason: 'pagehide' });
    });

    chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id) return false;
      const cmd = parseTabCommand(raw);
      if (!cmd) return false;
      if (cmd.t === 'replay') void this.play('manual');
      else if (cmd.t === 'stop') this.bridge.send({ type: 'stop', reason: 'user-stop' });
      else this.publish(true);
      sendResponse({ ok: true });
      return false;
    });

    onSettingsChanged((s) => {
      this.settings = s;
      void this.ensureClip();
      this.publish();
    });
    this.settings = await loadSettings();
    this.settingsLoaded = true;
    void this.ensureClip();
    this.tick(true);
  }

  // ---- detection -------------------------------------------------------------------------

  private scheduleTick(): void {
    if (this.tickTimer !== undefined) return;
    this.tickTimer = window.setTimeout(() => {
      this.tickTimer = undefined;
      this.tick(false);
    }, 60);
  }

  private tick(queryPeers: boolean): void {
    if (this.dead) return;
    if (queryPeers) this.bridge.send({ type: 'query' }); // refreshes mute state; answers arrive as 'peers' events

    const dom = readDomSignals(document);
    this.debug = { path: window.location.pathname, ...dom };
    // If the URL is an unrecognised shape but the in-call UI is visible, we are clearly in a call:
    // identify it by its path instead of ignoring it.
    const meetCode = parseMeetCode(window.location.pathname) ?? (dom.leaveControl ? window.location.pathname : null);
    const t = this.machine.update(
      {
        meetCode,
        ...dom,
        pcConnected: this.peers.connected,
        pcAlive: this.peers.count > 0,
      },
      Date.now(),
    );
    this.transition = t;

    if (t.left) {
      this.bridge.send({ type: 'stop', reason: 'left-meeting' });
      this.routingResult = null;
      this.log('info', 'Left the meeting.');
    }
    if (t.entered) this.onEntered(t);
    if (t.state === 'preJoin' || t.state === 'waitingRoom') void this.ensureClip(); // preload so entry has no delay
    this.publish(t.changed);
  }

  private onEntered(t: Transition): void {
    if (t.entryId === this.handledEntryId) return;
    this.handledEntryId = t.entryId;
    this.log('info', 'Joined the meeting.');

    if (!this.settingsLoaded || !this.settings.enabled) return this.log('info', 'Entrance music is turned off.');
    if (!this.settings.clipId) return this.log('warn', 'No entrance clip is configured.');

    const last = Number(sessionStorage.getItem(LAST_AUTO_PLAY_KEY) ?? 0);
    const remaining = this.settings.cooldownSec * 1000 - (Date.now() - last);
    if (remaining > 0) {
      return this.log('info', `Skipped entrance music: cooldown active (${Math.ceil(remaining / 1000)}s left).`);
    }
    void this.play('auto');
  }

  // ---- clip hand-off ---------------------------------------------------------------------

  private clipKey(): string | null {
    const s = this.settings;
    return s.clipId ? `${s.clipId}|${s.startOffsetSec}|${s.durationSec}` : null;
  }

  private ensureClip(): Promise<boolean> {
    const key = this.clipKey();
    if (!key || !this.bridge.connected) return Promise.resolve(false);
    if (this.loadedClipKey === key) return Promise.resolve(true);
    if (this.clipLoading) return this.clipLoading; // a (possibly stale) load is in flight; next call retries
    const { clipId, startOffsetSec, durationSec } = this.settings;

    this.clipLoading = (async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ t: 'get-clip', clipId: clipId!, startOffsetSec, durationSec })) as GetClipResponse | undefined;
        if (!res || !res.ok) {
          this.log('error', res && !res.ok ? res.error : 'Could not load the clip from extension storage.');
          return false;
        }
        const wav = base64ToArrayBuffer(res.wavBase64);
        const ack = new Promise<boolean>((resolve) => {
          this.clipWaiter = { key, resolve };
          window.setTimeout(() => resolve(false), 3000);
        });
        if (!this.bridge.send({ type: 'load-clip', clipKey: key, wav }, [wav])) return false;
        return await ack;
      } catch (e) {
        this.log('error', e instanceof Error ? e.message : 'Clip load failed.');
        return false;
      } finally {
        this.clipLoading = null;
        this.clipWaiter = null;
        if (this.clipKey() !== this.loadedClipKey) window.setTimeout(() => void this.ensureClip(), 250);
      }
    })();
    return this.clipLoading;
  }

  // ---- playback --------------------------------------------------------------------------

  private async play(source: 'auto' | 'manual'): Promise<void> {
    if (this.playback !== 'idle') return;
    if (!this.bridge.connected) {
      this.routingResult = { state: 'no-peer-connection', detail: 'Page hook not connected. Reload this Meet tab.' };
      this.log('error', 'Page hook not connected. Reload this Meet tab and try again.');
      return;
    }
    if (!this.settings.clipId) return this.log('warn', 'No entrance clip is configured.');

    this.playback = 'loading';
    this.routingResult = null;
    this.publish(true);
    const ready = await this.ensureClip();
    if (!ready) {
      this.playback = 'idle';
      this.log('error', 'Entrance clip could not be prepared.');
      return;
    }
    const requestId = ++this.requestId;
    this.pendingPlays.set(requestId, source);
    const s = this.settings;
    this.bridge.send({
      type: 'play',
      requestId,
      source,
      volume: s.volume,
      durationSec: s.durationSec,
      fadeMs: s.fadeMs,
      monitor: s.monitorLocally,
    });
  }

  private onBridgeEvent(e: BridgeEvent): void {
    switch (e.type) {
      case 'peers':
        this.peers = e.peers;
        this.scheduleTick();
        this.publish();
        break;
      case 'clip-loaded':
        this.loadedClipKey = e.clipKey;
        this.clipWaiter?.key === e.clipKey && this.clipWaiter.resolve(true);
        break;
      case 'play-result': {
        const source = this.pendingPlays.get(e.requestId);
        this.pendingPlays.delete(e.requestId);
        if (e.ok) {
          this.playback = 'playing';
          if (source === 'auto') sessionStorage.setItem(LAST_AUTO_PLAY_KEY, String(Date.now()));
          this.log('info', source === 'auto' ? 'Entrance music started.' : 'Replay started.');
        } else {
          this.playback = 'idle';
          this.onPlayFailed(e.reason, e.message, source ?? 'manual');
        }
        this.publish(true);
        break;
      }
      case 'playback-ended':
        this.playback = 'idle';
        this.onPlaybackEnded(e.reason);
        this.publish(true);
        break;
      case 'routing':
        this.routingResult = { state: e.state, detail: e.detail };
        this.publish(true);
        break;
      case 'hello':
        break;
    }
  }

  private onPlayFailed(reason: PlayFailReason, message: string, source: 'auto' | 'manual'): void {
    if (reason === 'no-peer-connection') this.routingResult = { state: 'no-peer-connection', detail: message };
    else if (reason !== 'muted' && reason !== 'already-playing' && reason !== 'no-audio-sender') {
      this.routingResult = { state: 'failed', detail: message };
    }
    const level = reason === 'muted' ? 'warn' : 'error';
    this.log(level, message);
    // Always tell the user why nothing played (never silently un-mute them).
    if (source === 'auto' || reason !== 'already-playing') showToast(reason === 'muted' ? 'Entrance music skipped: you are muted.' : message, level);
  }

  private onPlaybackEnded(reason: StopReason): void {
    switch (reason) {
      case 'completed':
        return this.log('info', 'Entrance finished.');
      case 'muted-during-playback':
        return this.log('warn', 'Entrance stopped early because you muted.');
      case 'user-stop':
        return this.log('info', 'Entrance stopped.');
      case 'left-meeting':
      case 'pagehide':
        return this.log('info', 'Entrance stopped (left the meeting).');
      case 'replaced-by-meet':
        return this.log('warn', 'Entrance stopped: Google Meet changed the microphone.');
      case 'mic-ended':
        return this.log('warn', 'Entrance stopped: microphone ended.');
      case 'error':
        return this.log('error', 'Entrance stopped because of an error.');
    }
  }

  // ---- status ----------------------------------------------------------------------------

  private log(level: LogEntry['level'], message: string): void {
    this.lastEvent = { level, message, at: Date.now() };
    this.publish(true);
  }

  private derivedRouting(): RoutingInfo {
    if (this.routingResult) return this.routingResult;
    const inMeeting = this.transition?.state === 'joined';
    if (!this.bridge.connected) {
      return { state: 'no-peer-connection', detail: 'The page hook has not connected yet. Reload the Meet tab.' };
    }
    if (inMeeting && !this.peers.connected) {
      return { state: 'no-peer-connection', detail: "Google Meet's audio connection was not detected." };
    }
    if (this.peers.audioSender) {
      return { state: 'ready', detail: 'Microphone sender found. Delivery has not been tested yet.' };
    }
    return { state: 'unknown', detail: '' };
  }

  private publish(now = false): void {
    if (this.dead) return;
    if (now) return this.flush();
    if (this.publishTimer !== undefined) return;
    this.publishTimer = window.setTimeout(() => this.flush(), 150);
  }

  private flush(): void {
    window.clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    const status: Omit<TabStatus, 'tabId'> = {
      meetingState: this.transition?.state ?? 'idle',
      meetCode: this.transition?.meetCode ?? null,
      peers: this.peers,
      playback: this.playback,
      routing: this.derivedRouting(),
      lastEvent: this.lastEvent,
      injectionConnected: this.bridge.connected,
      debug: this.debug,
      updatedAt: Date.now(),
    };
    const fingerprint = JSON.stringify({ ...status, updatedAt: 0 });
    if (fingerprint === this.lastPublished) return;
    this.lastPublished = fingerprint;
    try {
      chrome.runtime.sendMessage({ t: 'status', status }).catch((e: unknown) => {
        // After an extension reload/update this orphaned script can no longer talk to the extension.
        if (String(e).includes('context invalidated')) this.dead = true;
      });
    } catch {
      this.dead = true;
    }
  }
}

try {
  void new EntryController().start();
} catch {
  // Never let a failure here affect the Meet page.
}
