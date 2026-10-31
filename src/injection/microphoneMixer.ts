// MAIN-world: plays the entrance clip INTO the outgoing Meet audio.
//
// How it works:
//   1. Find the RTCRtpSender that carries the user's microphone (PeerTracker).
//   2. Build a Web Audio graph:  mic track ─┐
//                                clip ──────┴─> limiter -> MediaStreamAudioDestinationNode
//   3. sender.replaceTrack(mixedTrack): remote participants now receive "mic + clip" over the
//      normal Meet audio connection (no renegotiation, no screen share).
//   4. When the clip ends (or anything goes wrong) sender.replaceTrack(originalMicTrack) puts
//      Meet's own track back and every resource is released.
//
// Safety rules enforced here:
//   - never plays while the mic is muted, never un-mutes anything;
//   - if Meet itself calls replaceTrack (device change, mute handling) we immediately back off;
//   - every exit path restores the original track and closes the AudioContext.

import { applyEnvelope, computeEnvelope } from '@/audio/envelope';
import type { PlayCommandOptions, PlayFailReason, StopReason } from '@/types/bridge';
import type { RoutingState } from '@/types/messages';
import type { PeerTracker } from './peerTracker';

export type PlayOutcome = { ok: true } | { ok: false; reason: PlayFailReason; message: string };

export interface PlayerHooks {
  onEnded(reason: StopReason): void;
  onRouting(state: RoutingState, detail: string): void;
  onPlayingChanged?(playing: boolean): void;
}

interface Session {
  sender: RTCRtpSender;
  original: MediaStreamTrack;
  mixed: MediaStreamTrack;
  ctx: AudioContext;
  clipGain: GainNode;
  endAtCtxTime: number;
  timers: number[];
  unhook: () => void;
  stopping: boolean;
  finished: boolean;
  reason?: StopReason;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST_STOP_MS = 100;

export class EntrancePlayer {
  private clip: { key: string; bytes: ArrayBuffer } | null = null;
  private session: Session | null = null;
  private starting = false;

  constructor(
    private tracker: PeerTracker,
    private hooks: PlayerHooks,
  ) {}

  get playing(): boolean {
    return this.session !== null || this.starting;
  }

  setClip(key: string, bytes: ArrayBuffer): void {
    this.clip = { key, bytes };
  }

  hasClip(key?: string): boolean {
    return this.clip !== null && (key === undefined || this.clip.key === key);
  }

  async play(opts: PlayCommandOptions): Promise<PlayOutcome> {
    if (this.playing) return fail('already-playing', 'Entrance audio is already playing.');
    if (!this.clip) return fail('no-clip', 'No entrance clip is loaded in the page.');

    this.starting = true;
    let ctx: AudioContext | null = null;
    try {
      const summary = this.tracker.summary();
      if (summary.count === 0) {
        return fail('no-peer-connection', "Google Meet's audio connection was not detected. Reload the Meet tab and rejoin.");
      }
      const sender = this.tracker.findMicSender();
      if (!sender || !sender.track) {
        return summary.connected
          ? fail('muted', 'No active microphone track found. You may be muted or your mic is off; nothing was played.')
          : fail('no-audio-sender', 'The meeting audio connection is not established yet.');
      }
      const original = sender.track;
      if (!original.enabled) return fail('muted', 'You are muted, so the entrance music was skipped. MeetEntry never un-mutes you.');

      ctx = new AudioContext({ latencyHint: 'interactive' });
      if (ctx.state !== 'running') await Promise.race([ctx.resume().catch(() => undefined), sleep(1000)]);
      if (ctx.state !== 'running') {
        return fail('autoplay-blocked', 'The browser blocked audio start (no user interaction on this page yet). Click anywhere in the meeting and try Replay.');
      }

      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(this.clip.bytes.slice(0));
      } catch {
        return fail('decode-failed', 'The entrance clip could not be decoded.');
      }

      // State may have changed while we awaited: re-validate before touching the sender.
      if (sender.track !== original || !original.enabled || original.readyState !== 'live') {
        return fail('muted', 'Microphone state changed while preparing; nothing was played.');
      }

      const dur = Math.min(opts.durationSec, buffer.duration);
      const mixInput = ctx.createGain();
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.1;
      const dest = ctx.createMediaStreamDestination();
      mixInput.connect(limiter).connect(dest);

      const micSource = ctx.createMediaStreamSource(new MediaStream([original]));
      micSource.connect(mixInput); // mic passes through at unity gain

      const clipGain = ctx.createGain();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(clipGain);
      clipGain.connect(mixInput);
      if (opts.monitor) clipGain.connect(ctx.destination);

      const t0 = ctx.currentTime + 0.05;
      applyEnvelope(clipGain.gain, t0, computeEnvelope(dur, opts.fadeMs, opts.volume));
      src.start(t0, 0, dur);

      const mixed = dest.stream.getAudioTracks()[0];
      if (!mixed) return fail('internal-error', 'Could not create the mixed audio track.');

      this.tracker.registerOverride(sender, original);
      try {
        await this.tracker.replaceTrackQuietly(sender, mixed);
      } catch (e) {
        this.tracker.clearOverride(sender);
        mixed.stop();
        return fail('internal-error', `Browser refused to swap the outgoing track: ${e instanceof Error ? e.message : String(e)}`);
      }

      const session: Session = {
        sender,
        original,
        mixed,
        ctx,
        clipGain,
        endAtCtxTime: t0 + dur,
        timers: [],
        unhook: () => undefined,
        stopping: false,
        finished: false,
      };
      this.session = session;
      ctx = null; // ownership moved to the session

      session.unhook = this.tracker.onReplaceTrack((s, track) => {
        if (!session.finished && s === session.sender && track !== session.mixed) void this.finish(session, 'replaced-by-meet');
      });
      session.timers.push(
        window.setInterval(() => this.watch(session), 100),
        window.setTimeout(() => void this.finish(session, 'completed'), dur * 1000 + 250),
      );
      src.onended = () => void this.finish(session, 'completed');
      this.hooks.onPlayingChanged?.(true);
      void this.verify(session, dur * 1000);
      return { ok: true };
    } catch (e) {
      return fail('internal-error', e instanceof Error ? e.message : 'Unexpected error while starting playback.');
    } finally {
      this.starting = false;
      if (ctx) void ctx.close().catch(() => undefined); // only still set on failure paths
    }
  }

  /** Stops playback. Fades out quickly for user-visible reasons, tears down at once for page-level ones. */
  stop(reason: StopReason): void {
    const s = this.session;
    if (!s || s.finished || s.stopping) return;
    const immediate = reason === 'pagehide' || reason === 'mic-ended' || reason === 'replaced-by-meet' || reason === 'error';
    if (immediate) {
      void this.finish(s, reason);
      return;
    }
    s.stopping = true;
    try {
      const now = s.ctx.currentTime;
      s.clipGain.gain.cancelScheduledValues(now);
      s.clipGain.gain.setValueAtTime(s.clipGain.gain.value, now);
      s.clipGain.gain.linearRampToValueAtTime(0, now + FAST_STOP_MS / 1000);
    } catch {
      /* context already closed */
    }
    window.setTimeout(() => void this.finish(s, reason), FAST_STOP_MS + 20);
  }

  private watch(s: Session): void {
    if (s.finished || s.stopping) return;
    if (s.original.readyState === 'ended') return this.stop('mic-ended');
    if (!s.original.enabled) return this.stop('muted-during-playback'); // user muted mid-clip
    if (s.ctx.currentTime > s.endAtCtxTime + 0.5) void this.finish(s, 'completed');
  }

  private async finish(s: Session, reason: StopReason): Promise<void> {
    if (s.finished) return;
    s.finished = true;
    s.reason = reason;
    s.timers.forEach((t) => {
      clearInterval(t);
      clearTimeout(t);
    });
    s.unhook();
    if (this.session === s) this.session = null;

    // Hand the sender back to Meet's own track unless Meet already took it over.
    if (reason !== 'replaced-by-meet') {
      try {
        if (s.sender.track === s.mixed) await this.tracker.replaceTrackQuietly(s.sender, s.original);
      } catch {
        /* sender closed (e.g. meeting ended): nothing to restore */
      }
    }
    this.tracker.clearOverride(s.sender);
    try {
      s.mixed.stop();
    } catch {
      /* ignore */
    }
    await s.ctx.close().catch(() => undefined);
    this.hooks.onPlayingChanged?.(false);
    this.hooks.onEnded(reason);
  }

  /** Samples the sender's own WebRTC stats during playback to check audio really leaves the browser. */
  private async verify(s: Session, durationMs: number): Promise<void> {
    const stat = { first: null as number | null, last: 0, peak: 0, samples: 0 };
    const deadline = performance.now() + Math.max(500, durationMs - 300);
    while (!s.finished && performance.now() < deadline) {
      await sleep(350);
      if (s.finished) break;
      try {
        const report = await s.sender.getStats();
        report.forEach((r: Record<string, unknown>) => {
          if (r.type === 'outbound-rtp' && (r.kind === 'audio' || r.mediaType === 'audio') && typeof r.bytesSent === 'number') {
            stat.first ??= r.bytesSent;
            stat.last = r.bytesSent;
            stat.samples++;
          }
          if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
            stat.peak = Math.max(stat.peak, r.audioLevel);
          }
        });
      } catch {
        break;
      }
    }
    const delta = stat.first === null ? 0 : stat.last - stat.first;
    if (stat.samples >= 2 && delta > 0 && stat.peak > 0.01) {
      this.hooks.onRouting(
        'sending-verified',
        `Sender stats: ${delta} audio bytes sent, peak level ${stat.peak.toFixed(2)} while the clip played.`,
      );
    } else if (!s.finished || s.reason === 'completed') {
      // Stopped early (mute, user stop, Meet took over) is inconclusive, so only a full run can "fail".
      this.hooks.onRouting(
        'failed',
        `Could not confirm outgoing audio from sender stats (samples ${stat.samples}, bytes sent ${delta}, peak level ${stat.peak.toFixed(2)}).`,
      );
    }
  }
}

function fail(reason: PlayFailReason, message: string): PlayOutcome {
  return { ok: false, reason, message };
}
