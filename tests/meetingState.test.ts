import { describe, expect, it } from 'vitest';
import { MeetingStateMachine, type Signals } from '@/content/meetingState';

const base: Signals = {
  meetCode: 'abc-defg-hij',
  leaveControl: false,
  waitingText: false,
  joinButton: true,
  pcConnected: false,
  pcAlive: false,
};
const inCall: Signals = { ...base, leaveControl: true, joinButton: false, pcConnected: true, pcAlive: true };

describe('MeetingStateMachine', () => {
  it('stays idle off meeting pages', () => {
    const m = new MeetingStateMachine();
    expect(m.update({ ...base, meetCode: null }, 0).state).toBe('idle');
  });

  it('pre-join and waiting room never count as joined', () => {
    const m = new MeetingStateMachine();
    expect(m.update(base, 0).state).toBe('preJoin');
    expect(m.update({ ...base, waitingText: true }, 100).state).toBe('waitingRoom');
    // media connected but no leave control (e.g. preview): not joined
    const t = m.update({ ...base, pcConnected: true, pcAlive: true }, 5000);
    expect(t.state).toBe('preJoin');
    expect(t.entered).toBe(false);
    // leave control but no media: not joined
    expect(m.update({ ...base, leaveControl: true }, 9000).entered).toBe(false);
  });

  it('requires both signals to be stable before entering, and enters exactly once', () => {
    const m = new MeetingStateMachine({ joinStableMs: 1000, leaveStableMs: 1500 });
    m.update(base, 0);
    expect(m.update(inCall, 1000).entered).toBe(false);
    expect(m.update(inCall, 1999).entered).toBe(false);
    const t = m.update(inCall, 2000);
    expect(t.entered).toBe(true);
    expect(t.state).toBe('joined');
    expect(t.entryId).toBe(1);
    for (let now = 2500; now < 20000; now += 500) expect(m.update(inCall, now).entered).toBe(false);
  });

  it('a flicker resets the join debounce', () => {
    const m = new MeetingStateMachine({ joinStableMs: 1000, leaveStableMs: 1500 });
    m.update(base, 0);
    m.update(inCall, 100);
    m.update(base, 600); // flicker
    expect(m.update(inCall, 700).entered).toBe(false);
    expect(m.update(inCall, 1600).entered).toBe(false);
    expect(m.update(inCall, 1700).entered).toBe(true);
  });

  it('rides out brief DOM re-renders while joined, then reports left once', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 1500 });
    m.update(base, 0);
    expect(m.update(inCall, 10).entered).toBe(true);
    const gone = { ...base, leaveControl: false, pcAlive: true, pcConnected: true };
    expect(m.update(gone, 1000).state).toBe('joined');
    expect(m.update(inCall, 1500).state).toBe('joined'); // came back
    expect(m.update(gone, 2000).state).toBe('joined');
    const t = m.update(gone, 3600);
    expect(t.state).toBe('left');
    expect(t.left).toBe(true);
    expect(m.update(gone, 4000).left).toBe(false);
  });

  it('media connection closing ends the session', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 1000 });
    m.update(base, 0);
    m.update(inCall, 1);
    m.update({ ...inCall, pcAlive: false, pcConnected: false }, 100);
    expect(m.update({ ...inCall, pcAlive: false, pcConnected: false }, 1200).left).toBe(true);
  });

  it('rejoining after leaving counts as a new entry', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 0 });
    m.update(base, 0);
    expect(m.update(inCall, 1).entryId).toBe(1);
    expect(m.update(base, 2).state).toBe('left');
    expect(m.update(base, 3).state).toBe('preJoin'); // join button visible again
    const t = m.update(inCall, 4);
    expect(t.entered).toBe(true);
    expect(t.entryId).toBe(2);
  });

  it('left state is sticky until a join screen appears', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 0 });
    m.update(base, 0);
    m.update(inCall, 1);
    const quiet = { ...base, joinButton: false };
    expect(m.update(quiet, 2).state).toBe('left');
    expect(m.update(quiet, 3).state).toBe('left');
    expect(m.update({ ...quiet, waitingText: true }, 4).state).toBe('waitingRoom');
  });

  it('switching meetings while joined reports left and starts fresh', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 5000 });
    m.update(base, 0);
    m.update(inCall, 1);
    const t = m.update({ ...base, meetCode: 'xyz-wxyz-abc' }, 2);
    expect(t.left).toBe(true);
    expect(t.state).toBe('preJoin');
    expect(t.meetCode).toBe('xyz-wxyz-abc');
  });

  it('navigating off the meeting page while joined reports left', () => {
    const m = new MeetingStateMachine({ joinStableMs: 0, leaveStableMs: 5000 });
    m.update(base, 0);
    m.update(inCall, 1);
    const t = m.update({ ...base, meetCode: null }, 2);
    expect(t.left).toBe(true);
    expect(t.state).toBe('idle');
  });
});
