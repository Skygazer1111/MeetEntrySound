// Pure meeting state machine (no DOM, no chrome APIs) so it can be unit tested with fake clocks.
//
//   idle ──(meeting URL)──> preJoin ──(waiting text)──> waitingRoom
//                              │                            │
//                              └──── joined ◄───────────────┘   (leave control AND connected media, held for joinStableMs)
//                                      │
//                                      └──> left  (leave control or media gone for leaveStableMs, or meeting changed)
//
// "joined" deliberately needs TWO independent signals so that the waiting room, the pre-join
// preview and error screens never count as having entered the meeting.

import type { MeetingStateName } from '@/types/messages';

export interface Signals {
  /** Meeting code from the URL, or null when not on a meeting page. */
  meetCode: string | null;
  /** DOM: the in-call "Leave call" control is present. */
  leaveControl: boolean;
  /** DOM: "Asking to be let in" style text is present (best effort, English only). */
  waitingText: boolean;
  /** DOM: a Join / Ask to join / Rejoin button is present (best effort, English only). */
  joinButton: boolean;
  /** Media: an RTCPeerConnection is in the "connected" state. */
  pcConnected: boolean;
  /** Media: at least one RTCPeerConnection exists that is not closed/failed. */
  pcAlive: boolean;
}

export interface MachineConfig {
  /** Both join signals must hold continuously this long before we call it "joined". */
  joinStableMs: number;
  /** Join signals must be gone this long before we call it "left" (rides out re-renders). */
  leaveStableMs: number;
}

export const DEFAULT_MACHINE_CONFIG: MachineConfig = { joinStableMs: 1000, leaveStableMs: 1500 };

export interface Transition {
  state: MeetingStateName;
  previous: MeetingStateName;
  changed: boolean;
  /** True exactly once per successful entry into a meeting. */
  entered: boolean;
  /** True exactly once when a joined session ends. */
  left: boolean;
  /** Increments with every entry; use it to ensure once-per-entry work. */
  entryId: number;
  meetCode: string | null;
}

export class MeetingStateMachine {
  state: MeetingStateName = 'idle';
  private code: string | null = null;
  private entryId = 0;
  private joinSince: number | null = null;
  private leaveSince: number | null = null;

  constructor(private cfg: MachineConfig = DEFAULT_MACHINE_CONFIG) {}

  update(sig: Signals, now: number): Transition {
    const previous = this.state;
    let entered = false;
    let left = false;

    if (sig.meetCode !== this.code) {
      if (this.state === 'joined') left = true; // switched meetings or navigated away mid-call
      this.code = sig.meetCode;
      this.joinSince = null;
      this.leaveSince = null;
      this.state = sig.meetCode ? 'preJoin' : 'idle';
    }

    if (this.state === 'joined') {
      if (sig.leaveControl && sig.pcAlive) {
        this.leaveSince = null;
      } else {
        this.leaveSince ??= now;
        if (now - this.leaveSince >= this.cfg.leaveStableMs) {
          this.state = 'left';
          this.leaveSince = null;
          left = true;
        }
      }
    } else if (this.code) {
      if (sig.leaveControl && sig.pcConnected) {
        this.joinSince ??= now;
        if (now - this.joinSince >= this.cfg.joinStableMs) {
          this.state = 'joined';
          this.joinSince = null;
          this.entryId++;
          entered = true;
        }
      } else {
        this.joinSince = null;
        if (this.state === 'left') {
          // Stay on "left" until the page shows a join/waiting screen again.
          if (sig.waitingText) this.state = 'waitingRoom';
          else if (sig.joinButton) this.state = 'preJoin';
        } else {
          this.state = sig.waitingText ? 'waitingRoom' : 'preJoin';
        }
      }
    }

    return {
      state: this.state,
      previous,
      changed: this.state !== previous,
      entered,
      left,
      entryId: this.entryId,
      meetCode: this.code,
    };
  }
}
