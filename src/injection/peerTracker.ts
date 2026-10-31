// MAIN-world: observes (never alters) the page's RTCPeerConnections so we know
//   1. whether Meet's media connection is up, and
//   2. which RTCRtpSender carries the user's outgoing microphone audio.
//
// Patching is deliberately minimal and defensive: every wrapper calls straight through to the
// original behaviour, and any internal failure is swallowed so the page is never affected.

import type { PeerSummary } from '@/types/messages';

type ReplaceHook = (sender: RTCRtpSender, track: MediaStreamTrack | null) => void;

export class PeerTracker {
  private pcs = new Set<RTCPeerConnection>();
  private changeListeners = new Set<() => void>();
  private replaceHooks = new Set<ReplaceHook>();
  private installed = false;

  /** Unpatched replaceTrack, for our own calls (they must not trigger the hooks). */
  private originalReplaceTrack: ((this: RTCRtpSender, t: MediaStreamTrack | null) => Promise<void>) | null = null;

  install(win: Window & typeof globalThis = window): void {
    if (this.installed) return;
    this.installed = true;

    const Original = win.RTCPeerConnection;
    if (typeof Original === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const tracker = this;
      const Wrapped = new Proxy(Original, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
          try {
            tracker.track(pc);
          } catch {
            /* never break the page */
          }
          return pc;
        },
      });
      win.RTCPeerConnection = Wrapped;
      const legacy = (win as unknown as Record<string, unknown>).webkitRTCPeerConnection;
      if (legacy) (win as unknown as Record<string, unknown>).webkitRTCPeerConnection = Wrapped;
    }

    const proto = win.RTCRtpSender?.prototype;
    if (proto && typeof proto.replaceTrack === 'function') {
      const original = proto.replaceTrack;
      this.originalReplaceTrack = original;
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const tracker = this;
      proto.replaceTrack = function patchedReplaceTrack(this: RTCRtpSender, track: MediaStreamTrack | null) {
        try {
          tracker.replaceHooks.forEach((h) => h(this, track));
        } catch {
          /* ignore */
        }
        return original.call(this, track);
      };
    }
  }

  /** Calls the page's original replaceTrack without notifying hooks. */
  replaceTrackQuietly(sender: RTCRtpSender, track: MediaStreamTrack | null): Promise<void> {
    const fn = this.originalReplaceTrack ?? RTCRtpSender.prototype.replaceTrack;
    return fn.call(sender, track);
  }

  onChange(cb: () => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  /** Called before the page's replaceTrack runs. Used to detect that Meet took the sender back. */
  onReplaceTrack(cb: ReplaceHook): () => void {
    this.replaceHooks.add(cb);
    return () => this.replaceHooks.delete(cb);
  }

  private track(pc: RTCPeerConnection): void {
    this.pcs.add(pc);
    const refresh = () => {
      if (pc.connectionState === 'closed') this.pcs.delete(pc);
      this.changeListeners.forEach((cb) => cb());
    };
    pc.addEventListener('connectionstatechange', refresh);
    pc.addEventListener('iceconnectionstatechange', refresh);
    pc.addEventListener('signalingstatechange', refresh);
    this.changeListeners.forEach((cb) => cb());
  }

  private alivePcs(): RTCPeerConnection[] {
    return [...this.pcs].filter((pc) => pc.connectionState !== 'closed' && pc.connectionState !== 'failed');
  }

  /**
   * The outgoing microphone sender: a sender on a connected peer connection whose track is a
   * live audio track. Returns null when there is none (not joined yet, or Meet detached the track).
   */
  findMicSender(): RTCRtpSender | null {
    for (const pc of this.alivePcs()) {
      if (pc.connectionState !== 'connected') continue;
      try {
        for (const sender of pc.getSenders()) {
          if (sender.track && sender.track.kind === 'audio' && sender.track.readyState === 'live') return sender;
        }
      } catch {
        /* pc closed concurrently */
      }
    }
    return null;
  }

  /** While we have swapped a sender's track, remember Meet's real mic track for mute reporting. */
  private overrides = new Map<RTCRtpSender, MediaStreamTrack>();

  registerOverride(sender: RTCRtpSender, original: MediaStreamTrack): void {
    this.overrides.set(sender, original);
  }

  clearOverride(sender: RTCRtpSender): void {
    this.overrides.delete(sender);
  }

  summary(): PeerSummary {
    const alive = this.alivePcs();
    const sender = this.findMicSender();
    const mic = sender ? (this.overrides.get(sender) ?? sender.track) : null;
    return {
      count: alive.length,
      connected: alive.some((pc) => pc.connectionState === 'connected'),
      audioSender: sender !== null,
      micMuted: mic ? !mic.enabled : null,
    };
  }
}
