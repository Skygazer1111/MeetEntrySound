import type { TabStatus } from '@/types/messages';

interface Props {
  status: TabStatus | null;
  hasClip: boolean;
  previewing: boolean;
  onPreview: () => void;
  onReplay: () => void;
  onStop: () => void;
}

export function PlaybackControls({ status, hasClip, previewing, onPreview, onReplay, onStop }: Props) {
  const inMeet = status !== null && status.meetingState === 'joined';
  const playing = status?.playback === 'playing';
  return (
    <div className="controls-row">
      <button type="button" className="btn primary" disabled={!hasClip} onClick={onPreview}>
        {previewing ? '■ Stop preview' : '▶ Preview'}
      </button>
      <button
        type="button"
        className="btn"
        disabled={!hasClip || !inMeet || playing}
        onClick={onReplay}
        title={inMeet ? 'Play into the current meeting (for testing)' : 'Join a Meet to test'}
      >
        Replay in Meet
      </button>
      <button type="button" className="btn danger" disabled={!playing} onClick={onStop} title="Immediately stop entrance audio in the meeting">
        Stop
      </button>
    </div>
  );
}
