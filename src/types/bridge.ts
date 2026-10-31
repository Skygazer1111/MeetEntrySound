// Protocol between the isolated-world content script and the MAIN-world injected script.
// Transported over a private MessageChannel port (never over window.postMessage, apart from
// the one-time port handoff). Everything crossing the boundary is validated on both sides.

import type { PeerSummary, RoutingState } from './messages';

export const BRIDGE_SOURCE = 'meetentry-bridge';
export const MAIN_READY_EVENT = 'meetentry:main-ready';

export type PlayFailReason =
  | 'no-clip'
  | 'no-peer-connection'
  | 'no-audio-sender'
  | 'muted'
  | 'already-playing'
  | 'autoplay-blocked'
  | 'decode-failed'
  | 'internal-error';

export type StopReason =
  | 'completed'
  | 'user-stop'
  | 'left-meeting'
  | 'muted-during-playback'
  | 'replaced-by-meet'
  | 'mic-ended'
  | 'pagehide'
  | 'error';

export interface PlayCommandOptions {
  volume: number; // 0..1
  durationSec: number; // 5..10 (clamped by the clip length)
  fadeMs: number;
  monitor: boolean;
}

export type BridgeCommand =
  | { type: 'load-clip'; clipKey: string; wav: ArrayBuffer }
  | ({ type: 'play'; requestId: number; source: 'auto' | 'manual' } & PlayCommandOptions)
  | { type: 'stop'; reason: StopReason }
  | { type: 'query' };

export type BridgeEvent =
  | { type: 'hello' }
  | { type: 'clip-loaded'; clipKey: string }
  | { type: 'peers'; peers: PeerSummary }
  | { type: 'play-result'; requestId: number; ok: true }
  | { type: 'play-result'; requestId: number; ok: false; reason: PlayFailReason; message: string }
  | { type: 'playback-ended'; reason: StopReason }
  | { type: 'routing'; state: RoutingState; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const STOP_REASONS: readonly string[] = [
  'completed', 'user-stop', 'left-meeting', 'muted-during-playback',
  'replaced-by-meet', 'mic-ended', 'pagehide', 'error',
];
const FAIL_REASONS: readonly string[] = [
  'no-clip', 'no-peer-connection', 'no-audio-sender', 'muted',
  'already-playing', 'autoplay-blocked', 'decode-failed', 'internal-error',
];
const ROUTING_STATES: readonly string[] = ['unknown', 'no-peer-connection', 'ready', 'sending-verified', 'failed'];

/** Hard cap on clip size accepted by the page-context script (10 s of 48 kHz mono 16-bit + header). */
export const MAX_CLIP_BYTES = 2 * 1024 * 1024;

export function parseBridgeCommand(v: unknown): BridgeCommand | null {
  if (!isObj(v) || typeof v.type !== 'string') return null;
  switch (v.type) {
    case 'load-clip':
      if (typeof v.clipKey !== 'string' || v.clipKey.length > 200) return null;
      if (!(v.wav instanceof ArrayBuffer) || v.wav.byteLength === 0 || v.wav.byteLength > MAX_CLIP_BYTES) return null;
      return { type: 'load-clip', clipKey: v.clipKey, wav: v.wav };
    case 'play':
      if (!isNum(v.requestId) || (v.source !== 'auto' && v.source !== 'manual')) return null;
      if (!isNum(v.volume) || !isNum(v.durationSec) || !isNum(v.fadeMs) || typeof v.monitor !== 'boolean') return null;
      return {
        type: 'play',
        requestId: v.requestId,
        source: v.source,
        volume: clamp(v.volume, 0, 1),
        durationSec: clamp(v.durationSec, 1, 10),
        fadeMs: clamp(v.fadeMs, 0, 2000),
        monitor: v.monitor,
      };
    case 'stop':
      return typeof v.reason === 'string' && STOP_REASONS.includes(v.reason)
        ? { type: 'stop', reason: v.reason as StopReason }
        : null;
    case 'query':
      return { type: 'query' };
    default:
      return null;
  }
}

export function parseBridgeEvent(v: unknown): BridgeEvent | null {
  if (!isObj(v) || typeof v.type !== 'string') return null;
  switch (v.type) {
    case 'hello':
      return { type: 'hello' };
    case 'clip-loaded':
      return typeof v.clipKey === 'string' ? { type: 'clip-loaded', clipKey: v.clipKey } : null;
    case 'peers': {
      const p = v.peers;
      if (!isObj(p) || !isNum(p.count) || typeof p.connected !== 'boolean' || typeof p.audioSender !== 'boolean') return null;
      if (p.micMuted !== null && typeof p.micMuted !== 'boolean') return null;
      return {
        type: 'peers',
        peers: { count: p.count, connected: p.connected, audioSender: p.audioSender, micMuted: p.micMuted as boolean | null },
      };
    }
    case 'play-result':
      if (!isNum(v.requestId)) return null;
      if (v.ok === true) return { type: 'play-result', requestId: v.requestId, ok: true };
      if (v.ok === false && typeof v.reason === 'string' && FAIL_REASONS.includes(v.reason) && typeof v.message === 'string') {
        return { type: 'play-result', requestId: v.requestId, ok: false, reason: v.reason as PlayFailReason, message: v.message.slice(0, 300) };
      }
      return null;
    case 'playback-ended':
      return typeof v.reason === 'string' && STOP_REASONS.includes(v.reason)
        ? { type: 'playback-ended', reason: v.reason as StopReason }
        : null;
    case 'routing':
      return typeof v.state === 'string' && ROUTING_STATES.includes(v.state) && typeof v.detail === 'string'
        ? { type: 'routing', state: v.state as RoutingState, detail: v.detail.slice(0, 300) }
        : null;
    default:
      return null;
  }
}
