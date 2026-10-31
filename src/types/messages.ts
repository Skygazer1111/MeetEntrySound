// Shared types for messages between extension contexts:
//   content script  --(chrome.runtime.sendMessage)-->  service worker
//   popup           --(chrome.tabs.sendMessage)------>  content script
// All inbound messages are validated with the parse* functions below.

export type MeetingStateName = 'idle' | 'preJoin' | 'waitingRoom' | 'joined' | 'left';

export type PlaybackPhase = 'idle' | 'loading' | 'playing';

/**
 * How far we have gotten in proving the outgoing audio path.
 *  - unknown:            nothing attempted yet
 *  - no-peer-connection: Meet's WebRTC connection was not observed (injection did not attach)
 *  - ready:              a live outgoing mic sender exists, we can attempt to inject
 *  - sending-verified:   during the last clip, local sender stats showed audio bytes leaving the
 *                        browser with signal present. This is NOT proof that other participants
 *                        heard it; only a receiving participant can confirm that.
 *  - failed:             the last attempt failed (see detail)
 */
export type RoutingState = 'unknown' | 'no-peer-connection' | 'ready' | 'sending-verified' | 'failed';

export interface RoutingInfo {
  state: RoutingState;
  detail: string;
}

export interface PeerSummary {
  /** Number of RTCPeerConnections that are not closed. */
  count: number;
  /** At least one connection is in the "connected" state. */
  connected: boolean;
  /** A live outgoing audio track is attached to a connected peer connection. */
  audioSender: boolean;
  /** true = mic track disabled (Meet muted), false = enabled, null = unknown / no track. */
  micMuted: boolean | null;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  at: number;
}

export interface TabStatus {
  tabId: number;
  meetingState: MeetingStateName;
  meetCode: string | null;
  peers: PeerSummary;
  playback: PlaybackPhase;
  routing: RoutingInfo;
  lastEvent: LogEntry | null;
  /** True once the MAIN-world script answered the handshake. */
  injectionConnected: boolean;
  /** Raw detection inputs, shown under Advanced settings > Diagnostics to debug detection. */
  debug?: { path: string; leaveControl: boolean; joinButton: boolean; waitingText: boolean };
  updatedAt: number;
}

/** Messages from the content script to the service worker. */
export type ContentToWorker =
  | { t: 'status'; status: Omit<TabStatus, 'tabId'> }
  | { t: 'get-clip'; clipId: string; startOffsetSec: number; durationSec: number };

export type GetClipResponse =
  | { ok: true; clipId: string; wavBase64: string }
  | { ok: false; error: string };

/** Commands from the popup to a Meet tab's content script. */
export type TabCommand = { t: 'replay' } | { t: 'stop' } | { t: 'ping' };

export const STATUS_STORAGE_KEY = 'meetentry.tabStatus';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const MEETING_STATES: readonly string[] = ['idle', 'preJoin', 'waitingRoom', 'joined', 'left'];
const PLAYBACK: readonly string[] = ['idle', 'loading', 'playing'];
const ROUTING: readonly string[] = ['unknown', 'no-peer-connection', 'ready', 'sending-verified', 'failed'];

export function parseTabCommand(v: unknown): TabCommand | null {
  if (!isObj(v)) return null;
  return v.t === 'replay' || v.t === 'stop' || v.t === 'ping' ? { t: v.t } : null;
}

function parseLog(v: unknown): LogEntry | null {
  if (!isObj(v)) return null;
  if (v.level !== 'info' && v.level !== 'warn' && v.level !== 'error') return null;
  if (typeof v.message !== 'string' || !isNum(v.at)) return null;
  return { level: v.level, message: v.message.slice(0, 300), at: v.at };
}

export function parseStatusPayload(v: unknown): Omit<TabStatus, 'tabId'> | null {
  if (!isObj(v)) return null;
  const peers = v.peers;
  const routing = v.routing;
  if (!isObj(peers) || !isObj(routing)) return null;
  if (typeof v.meetingState !== 'string' || !MEETING_STATES.includes(v.meetingState)) return null;
  if (typeof v.playback !== 'string' || !PLAYBACK.includes(v.playback)) return null;
  if (typeof routing.state !== 'string' || !ROUTING.includes(routing.state)) return null;
  if (typeof routing.detail !== 'string') return null;
  if (!isNum(peers.count) || typeof peers.connected !== 'boolean' || typeof peers.audioSender !== 'boolean') return null;
  if (peers.micMuted !== null && typeof peers.micMuted !== 'boolean') return null;
  return {
    meetingState: v.meetingState as MeetingStateName,
    meetCode: typeof v.meetCode === 'string' ? v.meetCode.slice(0, 40) : null,
    peers: {
      count: peers.count,
      connected: peers.connected,
      audioSender: peers.audioSender,
      micMuted: peers.micMuted as boolean | null,
    },
    playback: v.playback as PlaybackPhase,
    routing: { state: routing.state as RoutingState, detail: routing.detail.slice(0, 300) },
    lastEvent: v.lastEvent === null || v.lastEvent === undefined ? null : parseLog(v.lastEvent),
    injectionConnected: v.injectionConnected === true,
    debug:
      isObj(v.debug) && typeof v.debug.path === 'string'
        ? {
            path: v.debug.path.slice(0, 120),
            leaveControl: v.debug.leaveControl === true,
            joinButton: v.debug.joinButton === true,
            waitingText: v.debug.waitingText === true,
          }
        : undefined,
    updatedAt: isNum(v.updatedAt) ? v.updatedAt : Date.now(),
  };
}

export function parseContentToWorker(v: unknown): ContentToWorker | null {
  if (!isObj(v)) return null;
  if (v.t === 'status') {
    const status = parseStatusPayload(v.status);
    return status ? { t: 'status', status } : null;
  }
  if (v.t === 'get-clip') {
    if (typeof v.clipId !== 'string' || v.clipId.length > 100) return null;
    if (!isNum(v.startOffsetSec) || !isNum(v.durationSec)) return null;
    return { t: 'get-clip', clipId: v.clipId, startOffsetSec: v.startOffsetSec, durationSec: v.durationSec };
  }
  return null;
}
