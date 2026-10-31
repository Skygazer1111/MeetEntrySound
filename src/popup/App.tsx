import { useEffect, useRef, useState } from 'react';
import { PreviewPlayer } from '@/audio/audioManager';
import { useClip, useMeetStatus, useSettings } from './hooks';
import { AudioDropzone } from './components/AudioDropzone';
import { Waveform } from './components/Waveform';
import { AutoPlayToggle, DurationSelector, VolumeSlider } from './components/Controls';
import { MeetStatusPanel } from './components/MeetStatusPanel';
import { PlaybackControls } from './components/PlaybackControls';

function fmt(sec: number): string {
  return `${sec.toFixed(1)}s`;
}

export function App() {
  const { settings, loaded, update } = useSettings();
  const { clip, error, busy, upload, remove, clearError } = useClip(settings, update);
  const { status, send } = useMeetStatus();
  const [progress, setProgress] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const player = useRef<PreviewPlayer | null>(null);

  useEffect(() => {
    player.current = new PreviewPlayer(setProgress);
    return () => player.current?.stop();
  }, []);

  if (!loaded) return <div className="app" />;

  const hasClip = clip !== null;
  const maxStart = Math.max(0, settings.clipLengthSec - settings.durationSec);

  const togglePreview = async () => {
    const p = player.current;
    if (!p || !clip) return;
    if (p.playing) return p.stop();
    try {
      await p.play(clip.wav, {
        startOffsetSec: Math.min(settings.startOffsetSec, maxStart),
        durationSec: settings.durationSec,
        volume: settings.volume,
        fadeMs: settings.fadeMs,
      });
    } catch {
      setNotice('Could not play the preview.');
    }
  };

  const flashNotice = (m: string) => {
    setNotice(m);
    window.setTimeout(() => setNotice(null), 4000);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="icons/icon48.png" width="28" height="28" alt="" />
          <div>
            <div className="brand-name">MeetEntry</div>
            <div className="muted">Your walk-out music for Google Meet</div>
          </div>
        </div>
        <AutoPlayToggle
          checked={settings.enabled && hasClip}
          disabled={!hasClip}
          onChange={(enabled) => update({ enabled })}
        />
      </header>

      <MeetStatusPanel status={status} />

      <section className="card">
        <div className="card-title">Entrance clip</div>
        {!hasClip ? (
          <AudioDropzone busy={busy} error={error} onFile={upload} />
        ) : (
          <>
            <div className="clip-head">
              <div className="clip-name" title={settings.clipName ?? ''}>
                {settings.clipName}
              </div>
              <div className="clip-actions">
                <label className="link">
                  Replace
                  <input
                    type="file"
                    accept=".mp3,.wav,audio/mpeg,audio/wav"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) void upload(f);
                    }}
                  />
                </label>
                <button type="button" className="link danger-text" onClick={() => void remove()}>
                  Remove
                </button>
              </div>
            </div>
            <Waveform
              wav={clip.wav}
              lengthSec={settings.clipLengthSec}
              startOffsetSec={Math.min(settings.startOffsetSec, maxStart)}
              durationSec={settings.durationSec}
              progress={progress}
              onStartChange={(startOffsetSec) => update({ startOffsetSec })}
            />
            <div className="muted wave-caption">
              Plays {fmt(Math.min(settings.startOffsetSec, maxStart))} – {fmt(Math.min(settings.startOffsetSec, maxStart) + settings.durationSec)} of{' '}
              {fmt(settings.clipLengthSec)}
              {settings.clipLengthSec > settings.durationSec + 0.05 && ' · drag the waveform to move the window'}
            </div>
            {error && <div className="alert error" onClick={clearError}>{error}</div>}
          </>
        )}
      </section>

      <section className="card">
        <div className="field-row">
          <div className="card-title">Duration</div>
          <DurationSelector value={settings.durationSec} onChange={(durationSec) => update({ durationSec })} />
        </div>
        <div className="field-row">
          <div className="card-title">Volume</div>
          <VolumeSlider value={settings.volume} onChange={(volume) => update({ volume })} />
        </div>
      </section>

      <PlaybackControls
        status={status}
        hasClip={hasClip}
        previewing={progress !== null}
        onPreview={() => void togglePreview()}
        onReplay={() =>
          void send({ t: 'replay' }).then((ok) => !ok && flashNotice('Could not reach the Meet tab. Try reloading it.'))
        }
        onStop={() => void send({ t: 'stop' })}
      />
      {notice && <div className="alert warn">{notice}</div>}

      <section className="card">
        <button type="button" className="disclosure" onClick={() => setProfileOpen((o) => !o)} aria-expanded={profileOpen}>
          <span className="card-title">Profile</span>
          <span className="muted">{settings.displayName || 'optional'} {profileOpen ? '▴' : '▾'}</span>
        </button>
        {profileOpen && (
          <div className="profile-fields">
            <label>
              <span className="muted">Display name in Meet</span>
              <input
                type="text"
                value={settings.displayName}
                maxLength={80}
                onChange={(e) => update({ displayName: e.target.value })}
                placeholder="e.g. Alex"
              />
            </label>
            <label>
              <span className="muted">Gmail (label only, never sent anywhere)</span>
              <input
                type="email"
                value={settings.email}
                maxLength={120}
                onChange={(e) => update({ email: e.target.value })}
                placeholder="you@gmail.com"
              />
            </label>
          </div>
        )}
      </section>

      <footer className="footer">
        <span className="muted">Audio never leaves this device.</span>
        <button type="button" className="link" onClick={() => void chrome.runtime.openOptionsPage()}>
          Advanced settings
        </button>
      </footer>
    </div>
  );
}
