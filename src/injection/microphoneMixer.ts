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

import { buildClipChain, softClipCurve } from '@/audio/clipMastering';
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
  savedEncoding: SavedEncoding | null;
  timers: number[];
  unhook: () => void;
  stopping: boolean;
  finished: boolean;
  reason?: StopReason;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const FAST_STOP_MS = 100;

const LIMITER = { threshold: -6, knee: 6, ratio: 6, attack: 0.005, release: 0.25, trim: 0.85 } as const;
const DUCK_GAIN = 0.3;
const DUCK_RAMP_SEC = 0.15;
const BOOST_MAX_BITRATE = 128_000;

/** Ducks the mic while the clip plays: ramp down at the start, back up at the end. */
function scheduleDuck(param: AudioParam, t0: number, durSec: number): void {
  const ramp = Math.min(DUCK_RAMP_SEC, durSec / 4);
  param.cancelScheduledValues(0);
  param.setValueAtTime(1, Math.max(0, t0 - 0.01));
  param.linearRampToValueAtTime(DUCK_GAIN, t0 + ramp);
  param.setValueAtTime(DUCK_GAIN, t0 + durSec - ramp);
  param.linearRampToValueAtTime(1, t0 + durSec);
}

interface SavedEncoding {
  maxBitrate: number | undefined;
  priority: RTCPriorityType | undefined;
  networkPriority: RTCPriorityType | undefined;
}

type EncodingParams = RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType };

/**
 * Raises the sender's bitrate cap and priority while the clip plays (Meet's default voice bitrate
 * is low for music). Returns what to restore, or null if the browser refused (never fatal).
 */
function boostEncoding(sender: RTCRtpSender): SavedEncoding | null {
  try {
    const params = sender.getParameters();
    const enc = params.encodings?.[0] as EncodingParams | undefined;
    if (!enc) return null;
    const saved: SavedEncoding = { maxBitrate: enc.maxBitrate, priority: enc.priority, networkPriority: enc.networkPriority };
    if (enc.maxBitrate === undefined || enc.maxBitrate < BOOST_MAX_BITRATE) enc.maxBitrate = BOOST_MAX_BITRATE;
    enc.priority = 'high';
    enc.networkPriority = 'high';
    void sender.setParameters(params).catch(() => undefined);
    return saved;
  } catch {
    return null;
  }
}

function restoreEncoding(sender: RTCRtpSender, saved: SavedEncoding | null): void {
  if (!saved) return;
  try {
    const params = sender.getParameters();
    const enc = params.encodings?.[0] as EncodingParams | undefined;
    if (!enc) return;
    if (saved.maxBitrate === undefined) delete enc.maxBitrate;
    else enc.maxBitrate = saved.maxBitrate;
    if (saved.priority === undefined) delete enc.priority;
    else enc.priority = saved.priority;
    if (saved.networkPriority === undefined) delete enc.networkPriority;
    else enc.networkPriority = saved.networkPriority;
    void sender.setParameters(params).catch(() => undefined);
  } catch {
    /* sender closed (meeting ended): nothing to restore */
  }
}

export class EntrancePlayer {
  private clip: { key: string; bytes: ArrayBuffer } | null = null;
  private session: Session | null = null;
  private starting = false;
  private abortStart = false;

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
      this.abortStart = false;
      const acquired = await this.acquireMic(opts.waitForMicMs ?? 0);
      if (!acquired.ok) return acquired.outcome;
      const { sender, original } = acquired;

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
      // Gentle limiter (Chrome's compressor adds automatic makeup gain, cancelled by `trim`),
      // then a tanh soft-clip as the last safety stage instead of hard clipping.
      limiter.threshold.value = LIMITER.threshold;
      limiter.knee.value = LIMITER.knee;
      limiter.ratio.value = LIMITER.ratio;
      limiter.attack.value = LIMITER.attack;
      limiter.release.value = LIMITER.release;
      const trim = ctx.createGain();
      trim.gain.value = LIMITER.trim;
      const softClip = ctx.createWaveShaper();
      softClip.curve = softClipCurve();
      softClip.oversample = '2x';
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      mixInput.connect(limiter).connect(trim).connect(softClip).connect(dest);

      // Mic passes through a gain node so it can be ducked while the clip plays (less room noise
      // and echo bleeding into the music, and more headroom for the clip).
      const micSource = ctx.createMediaStreamSource(new MediaStream([original]));
      const micGain = ctx.createGain();
      micSource.connect(micGain).connect(mixInput);

      const clipGain = ctx.createGain();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const chain = buildClipChain(ctx);
      src.connect(chain.input);
      chain.output.connect(clipGain);
      clipGain.connect(mixInput);
      if (opts.monitor) clipGain.connect(ctx.destination);

      const t0 = ctx.currentTime + 0.05;
      applyEnvelope(clipGain.gain, t0, computeEnvelope(dur, opts.fadeMs, opts.volume));
      scheduleDuck(micGain.gain, t0, dur);
      src.start(t0, 0, dur);

      const mixed = dest.stream.getAudioTracks()[0];
      if (!mixed) return fail('internal-error', 'Could not create the mixed audio track.');

      this.tracker.registerOverride(sender, original);
      const savedEncoding = boostEncoding(sender);
      try {
        await this.tracker.replaceTrackQuietly(sender, mixed);
      } catch (e) {
        restoreEncoding(sender, savedEncoding);
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
        savedEncoding,
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

  /**
   * Finds the live, enabled microphone sender. Right after admission from a waiting room Meet may
   * attach or enable the mic track a moment later, so for automatic plays we keep looking for up to
   * `maxWaitMs` before giving up. We only ever WAIT for the user to be unmuted; we never unmute.
   */
  private async acquireMic(
    maxWaitMs: number,
  ): Promise<{ ok: true; sender: RTCRtpSender; original: MediaStreamTrack } | { ok: false; outcome: PlayOutcome }> {
    const deadline = performance.now() + maxWaitMs;
    for (;;) {
      let failure: PlayOutcome;
      const summary = this.tracker.summary();
      if (summary.count === 0) {
        failure = fail('no-peer-connection', "Google Meet's audio connection was not detected. Reload the Meet tab and rejoin.");
      } else {
        const sender = this.tracker.findMicSender();
        if (!sender || !sender.track) {
          failure = summary.connected
            ? fail('muted', 'No active microphone track found. You may be muted or your mic is off; nothing was played.')
            : fail('no-audio-sender', 'The meeting audio connection is not established yet.');
        } else if (!sender.track.enabled) {
          failure = fail('muted', 'You are muted, so the entrance music was skipped. MeetEntry never un-mutes you.');
        } else {
          return { ok: true, sender, original: sender.track };
        }
      }
      if (this.abortStart) return { ok: false, outcome: fail('cancelled', 'Entrance cancelled before it started.') };
      if (performance.now() >= deadline) return { ok: false, outcome: failure };
      await sleep(200);
    }
  }

  /** Stops playback. Fades out quickly for user-visible reasons, tears down at once for page-level ones. */
  stop(reason: StopReason): void {
    if (this.starting) this.abortStart = true; // abandon a pending wait for the mic
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
    restoreEncoding(s.sender, s.savedEncoding);
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
    const stat = { first: null as number | null, last: 0, peak: 0, samples: 0, targetBitrate: null as number | null };
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
            if (typeof r.targetBitrate === 'number') stat.targetBitrate = r.targetBitrate;
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
        `Sender stats: ${delta} audio bytes sent, peak level ${stat.peak.toFixed(2)} while the clip played` +
          (stat.targetBitrate !== null ? `, target bitrate ${Math.round(stat.targetBitrate / 1000)} kbps.` : '.'),
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
