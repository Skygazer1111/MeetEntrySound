import { describe, expect, it } from 'vitest';
import { parseBridgeCommand, parseBridgeEvent, MAX_CLIP_BYTES } from '@/types/bridge';
import { parseContentToWorker, parseTabCommand } from '@/types/messages';

describe('bridge command validation', () => {
  const play = { type: 'play', requestId: 1, source: 'auto', volume: 0.5, durationSec: 7, fadeMs: 400, monitor: false };

  it('accepts a valid play command and clamps out-of-range values', () => {
    expect(parseBridgeCommand(play)).toMatchObject({ type: 'play', volume: 0.5, durationSec: 7 });
    const c = parseBridgeCommand({ ...play, volume: 9, durationSec: 999, fadeMs: -5 });
    expect(c).toMatchObject({ volume: 1, durationSec: 10, fadeMs: 0 });
  });

  it('rejects malformed commands', () => {
    expect(parseBridgeCommand(null)).toBeNull();
    expect(parseBridgeCommand('play')).toBeNull();
    expect(parseBridgeCommand({ type: 'play' })).toBeNull();
    expect(parseBridgeCommand({ ...play, source: 'evil' })).toBeNull();
    expect(parseBridgeCommand({ ...play, volume: 'loud' })).toBeNull();
    expect(parseBridgeCommand({ type: 'stop', reason: 'because' })).toBeNull();
    expect(parseBridgeCommand({ type: 'unknown' })).toBeNull();
  });

  it('validates clips by type and size', () => {
    expect(parseBridgeCommand({ type: 'load-clip', clipKey: 'k', wav: new ArrayBuffer(10) })).not.toBeNull();
    expect(parseBridgeCommand({ type: 'load-clip', clipKey: 'k', wav: new ArrayBuffer(0) })).toBeNull();
    expect(parseBridgeCommand({ type: 'load-clip', clipKey: 'k', wav: new ArrayBuffer(MAX_CLIP_BYTES + 1) })).toBeNull();
    expect(parseBridgeCommand({ type: 'load-clip', clipKey: 'k', wav: 'bytes' })).toBeNull();
  });
});

describe('bridge event validation', () => {
  it('accepts well-formed events', () => {
    expect(parseBridgeEvent({ type: 'hello' })).toEqual({ type: 'hello' });
    expect(parseBridgeEvent({ type: 'play-result', requestId: 2, ok: true })).toMatchObject({ ok: true });
    expect(parseBridgeEvent({ type: 'play-result', requestId: 2, ok: false, reason: 'muted', message: 'm' })).toMatchObject({ reason: 'muted' });
    expect(parseBridgeEvent({ type: 'peers', peers: { count: 1, connected: true, audioSender: true, micMuted: null } })).not.toBeNull();
  });

  it('rejects bad events', () => {
    expect(parseBridgeEvent({ type: 'play-result', requestId: 2, ok: false, reason: 'nope', message: 'm' })).toBeNull();
    expect(parseBridgeEvent({ type: 'peers', peers: { count: 'x' } })).toBeNull();
    expect(parseBridgeEvent({ type: 'routing', state: 'amazing', detail: '' })).toBeNull();
    expect(parseBridgeEvent(undefined)).toBeNull();
  });
});

describe('extension message validation', () => {
  it('validates tab commands', () => {
    expect(parseTabCommand({ t: 'replay' })).toEqual({ t: 'replay' });
    expect(parseTabCommand({ t: 'format-disk' })).toBeNull();
    expect(parseTabCommand(7)).toBeNull();
  });

  it('validates content-to-worker messages', () => {
    expect(parseContentToWorker({ t: 'get-clip', clipId: 'a', startOffsetSec: 0, durationSec: 7 })).not.toBeNull();
    expect(parseContentToWorker({ t: 'get-clip', clipId: 5 })).toBeNull();
    const status = {
      meetingState: 'joined',
      meetCode: 'abc-defg-hij',
      peers: { count: 1, connected: true, audioSender: true, micMuted: false },
      playback: 'idle',
      routing: { state: 'ready', detail: '' },
      lastEvent: null,
      injectionConnected: true,
      updatedAt: 1,
    };
    expect(parseContentToWorker({ t: 'status', status })).not.toBeNull();
    expect(parseContentToWorker({ t: 'status', status: { ...status, meetingState: 'hacked' } })).toBeNull();
    expect(parseContentToWorker({ t: 'other' })).toBeNull();
  });
});
