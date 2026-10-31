import type { MeetingStateName, TabStatus } from '@/types/messages';

const STATE_LABEL: Record<MeetingStateName, string> = {
  idle: 'Not in a meeting',
  preJoin: 'On the join screen',
  waitingRoom: 'Waiting to be let in',
  joined: 'In the meeting',
  left: 'Left the meeting',
};

function routingText(s: TabStatus): { tone: 'ok' | 'warn' | 'bad' | 'idle'; title: string; detail: string } {
  const r = s.routing;
  switch (r.state) {
    case 'sending-verified':
      return {
        tone: 'ok',
        title: 'Audio sent (sender-side check)',
        detail: `${r.detail} Not confirmed on the receiving side. Only another participant can confirm they heard it.`,
      };
    case 'ready':
      return { tone: 'idle', title: 'Audio path ready, not yet tested', detail: r.detail };
    case 'failed':
      return { tone: 'bad', title: 'Last attempt failed', detail: r.detail };
    case 'no-peer-connection':
      return { tone: 'warn', title: 'Meet audio connection not detected', detail: r.detail };
    default:
      return { tone: 'idle', title: 'Audio routing not verified', detail: r.detail || 'Nothing has been played in this tab yet.' };
  }
}

export function MeetStatusPanel({ status }: { status: TabStatus | null }) {
  if (!status) {
    return (
      <div className="card status">
        <div className="status-row">
          <span className="dot idle" />
          <div>
            <div className="status-title">No Google Meet tab detected</div>
            <div className="muted">Open or reload a meet.google.com tab after installing.</div>
          </div>
        </div>
      </div>
    );
  }
  const routing = routingText(status);
  const joined = status.meetingState === 'joined';
  return (
    <div className="card status">
      <div className="status-row">
        <span className={`dot ${joined ? 'ok' : 'idle'}`} />
        <div>
          <div className="status-title">{STATE_LABEL[status.meetingState]}</div>
          {status.meetCode && <div className="muted mono">{status.meetCode}</div>}
        </div>
        {status.playback === 'playing' && <span className="pill live">Playing</span>}
        {status.peers.micMuted === true && joined && <span className="pill">Muted</span>}
      </div>
      <div className="status-row">
        <span className={`dot ${routing.tone}`} />
        <div>
          <div className="status-title small">{routing.title}</div>
          <div className="muted">{routing.detail}</div>
        </div>
      </div>
      {!status.injectionConnected && (
        <div className="alert warn">Page hook not connected. Reload the Meet tab (it must be reloaded after installing or updating MeetEntry).</div>
      )}
      {status.lastEvent && status.lastEvent.level !== 'info' && (
        <div className={`alert ${status.lastEvent.level === 'error' ? 'error' : 'warn'}`}>{status.lastEvent.message}</div>
      )}
    </div>
  );
}
