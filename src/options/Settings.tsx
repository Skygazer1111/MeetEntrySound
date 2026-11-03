import { useMeetStatus, useSettings } from '@/popup/hooks';

export function Settings() {
  const { settings, loaded, update } = useSettings();
  const { status } = useMeetStatus();
  if (!loaded) return null;

  return (
    <div className="options">
      <h1>MeetEntry settings</h1>
      <p className="muted">Everything is stored locally in this browser. No account, no server.</p>

      <section className="card">
        <div className="card-title">Repeat protection</div>
        <label className="opt">
          <span>
            Cooldown between automatic plays
            <span className="muted block">
              Prevents the clip from replaying if you drop out and rejoin quickly. Set to 0 to allow every join to play.
            </span>
          </span>
          <span className="inline">
            <input
              type="number"
              min={0}
              max={600}
              value={settings.cooldownSec}
              onChange={(e) => update({ cooldownSec: Number(e.target.value) })}
            />
            s
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card-title">Fades</div>
        <label className="opt">
          <span>
            Fade in / fade out
            <span className="muted block">Softens the start and end so the clip does not click or cut off abruptly.</span>
          </span>
          <span className="inline">
            <input
              type="number"
              min={0}
              max={1500}
              step={50}
              value={settings.fadeMs}
              onChange={(e) => update({ fadeMs: Number(e.target.value) })}
            />
            ms
          </span>
        </label>
      </section>

      <section className="card">
        <div className="card-title">Monitoring</div>
        <label className="opt">
          <span>
            Hear the clip on my own speakers while it plays in the meeting
            <span className="muted block">Off by default. Without headphones this can cause echo for other participants.</span>
          </span>
          <input type="checkbox" checked={settings.monitorLocally} onChange={(e) => update({ monitorLocally: e.target.checked })} />
        </label>
      </section>

      <section className="card">
        <div className="card-title">Studio sound</div>
        <label className="opt">
          <span>
            Switch off Meet&apos;s Studio sound while the clip plays
            <span className="muted block">
              Studio sound / noise cancellation filters out anything that is not speech, which breaks up music. MeetEntry
              briefly opens Meet&apos;s Settings &gt; Audio, turns it off, plays the clip, then turns it back on. If Meet&apos;s
              layout changes this can fail; you will see a notice and the clip still plays. You can also turn Studio sound
              off yourself in Meet and disable this option.
            </span>
          </span>
          <input
            type="checkbox"
            checked={settings.autoDisableStudioSound}
            onChange={(e) => update({ autoDisableStudioSound: e.target.checked })}
          />
        </label>
      </section>

      <section className="card">
        <div className="card-title">Diagnostics</div>
        {status ? (
          <pre className="diag">{JSON.stringify(status, null, 2)}</pre>
        ) : (
          <div className="muted">No Google Meet tab has reported status yet.</div>
        )}
      </section>

      <section className="card">
        <div className="card-title">Known limitations</div>
        <ul className="muted">
          <li>The clip is mixed into your outgoing microphone audio. It only plays when your mic is unmuted.</li>
          <li>
            Google Meet&apos;s Studio sound / noise cancellation removes music. MeetEntry can switch it off for the clip
            automatically (see above), or you can turn it off yourself: Settings &gt; Audio &gt; Studio sound.
          </li>
          <li>&quot;Audio sent&quot; means your browser reported outgoing audio. Only another participant can confirm they heard it.</li>
          <li>If Google changes Meet internals, MeetEntry fails safe and leaves your microphone untouched.</li>
        </ul>
      </section>
    </div>
  );
}
