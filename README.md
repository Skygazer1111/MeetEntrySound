# MeetEntry

Play your own entrance music when you join a Google Meet, like a wrestler's theme. Only **you** need the
extension; everyone else hears the clip through the normal Meet audio connection. No screen sharing, no
server, no account.

> **Status: built and tested up to the edge of Google Meet.** The audio mechanism, meeting detection, safety
> behaviour and UI are implemented and verified automatically (see [What is verified](#what-is-verified-and-what-is-not)).
> **It has not yet been verified inside a real Google Meet with a second participant.** That is the one thing only
> you can confirm, using the [two-participant test](#two-participant-acceptance-test) below. Until you have run it,
> treat "other people can hear it" as unproven.

## How it works

```
 your mic ─────────┐
                   ├─> Web Audio mix ─> MediaStreamDestination ─> RTCRtpSender.replaceTrack()
 entrance clip ────┘                                               (Meet's own outgoing audio connection)
```

1. A script injected into `meet.google.com` at `document_start` (Manifest V3, `world: "MAIN"`) watches Meet's
   `RTCPeerConnection`s so it can find the sender that carries your microphone.
2. A second (isolated) content script watches the page for the moment you actually enter the meeting. It needs
   **two** independent signals held for 1 second: the in-call "Leave call" control in the DOM *and* a connected
   media connection. The pre-join screen and the waiting room never count.
3. On entry it asks the page script to play your clip. The page script mixes mic + clip with the Web Audio API and
   swaps the mixed track onto the existing sender (`replaceTrack`, no renegotiation). When the clip finishes, or
   anything goes wrong, Meet's original microphone track is put back and the audio context is closed.

Safety rules baked in: never plays while you are muted (and never un-mutes you), stops fast if you mute
mid-clip, backs off immediately if Meet itself changes the microphone track, restores everything when you leave
or the page unloads, one play per entry plus a configurable cooldown, and every cross-context message is validated.

## Install (development build)

Requires Node 20+ and Chrome 110+ on Windows/macOS/Linux.

```bash
npm install
npm run build
```

Then in Chrome: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and choose the
`dist/` folder. **Reload any open Meet tabs** (content scripts only attach to pages loaded after install/update).

Tip: this project lives in a OneDrive folder. `node_modules` syncs slowly; consider excluding it from OneDrive
or moving the project to a non-synced folder.

### Using it

1. Click the MeetEntry toolbar icon and drop in an MP3 or WAV (max 15 MB). The clip is decoded, converted to
   mono 48 kHz and stored in IndexedDB on your machine.
2. Pick a 5-10 s duration, drag the waveform to choose which part plays, set the volume, press **Preview**.
3. Turn the switch **On**. Join any Meet. When you enter (mic unmuted), the clip plays once.

The popup shows the live meeting state and audio routing status. **"Audio sent (sender-side check)"** means your
browser's own WebRTC statistics showed audio leaving your machine while the clip played. It does **not** prove
that other participants heard it.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run build` | Clean, type-check, build popup/options (Vite) and the three IIFE scripts into `dist/` |
| `npm test` | Unit tests (state machine, WAV/envelope, validation, storage) |
| `npm run test:loopback` | Real Chrome: injects into a page with a sender/receiver WebRTC pair and measures what the *receiver* hears |
| `npm run test:e2e` | Real Chrome: runs the real content + injected scripts against a mock Meet page |
| `npm run screenshots` | Renders popup/options to `screenshots/` with a mocked `chrome.*` |
| `npm run package` | Build and zip `dist/` to `meetentry-<version>.zip` for the Web Store |
| `npm run watch:ui` / `watch:scripts` | Rebuild on change (run in two terminals) |

`test:loopback` and `test:e2e` need Chrome installed (set `CHROME_PATH` if it is in a non-standard location).

## What is verified, and what is not

**Verified automatically (real Chrome, real WebRTC):**

- A tone injected through `replaceTrack` reaches a *receiving* peer (FFT of the received audio shows the clip at
  1500 Hz, and the original mic tone at 400 Hz keeps flowing during and after the clip).
- The clip stops at the configured duration, Meet's original track is restored, no audio at the receiver afterwards.
- Muted user: nothing plays, mic stays muted. Mute mid-clip: clip stops. Emergency stop works. If the page calls
  `replaceTrack` during the clip, we back off. Duplicate play requests are rejected.
- Against a mock Meet page: no play while only the media connection is up, one play per entry, no duplicates,
  cooldown honoured and explained, disabled switch honoured, leaving mid-clip stops audio, popup replay/stop work,
  messages from other extensions are ignored.
- The upload path (stereo 44.1 kHz WAV to stored mono 48 kHz) works in Chrome.

**Not verifiable by me, needs you:**

- That **real Google Meet** accepts the swapped track and forwards it. The mechanism is standard WebRTC and
  should work, but Meet is a closed application and may do things I cannot see from outside (for example, use of
  several peer connections, insertable-streams processing, or different mute handling).
- That the clip **survives Meet's noise cancellation** on listeners' side. Music is exactly what noise
  suppression tries to remove. See [Known limitations](#known-limitations).
- Meet's current DOM: detection uses the "Leave call" `aria-label` and the `call_end` icon, and *also* requires a
  connected peer connection, so a DOM change should make MeetEntry skip playing rather than misfire. But I could
  not test it against the live site.

## Two-participant acceptance test

You need two people/browsers in the same meeting: **A** (has MeetEntry) and **B** (does not). Two Chrome
profiles on one machine work, but use headphones on both to avoid echo, and ideally use two devices.

1. **A:** load the extension, upload a clip, set duration (e.g. 7 s), turn **On**, reload Meet tabs.
2. **B:** join a meeting normally, mic can be muted. B should open `chrome://webrtc-internals` and expand the
   inbound audio stream. The `audioLevel` / `totalAudioEnergy` graphs give objective proof of reception.
3. **A:** join with mic **unmuted**. The popup should go "On the join screen" to "In the meeting".
4. **Expect:** B hears the whole clip once; the popup on A shows "Audio sent (sender-side check)".
5. **A** speaks. B hears A normally.
6. No second play for the session. **A** leaves: any active audio stops. Rejoin within the cooldown: no play.
7. Turn the switch **Off**, rejoin (after the cooldown / set cooldown to 0): no music.
8. Join **muted**: no music, an on-page notice says it was skipped, and you are **not** un-muted.
9. Repeat with different mics, headphones and with Meet's **noise cancellation** both On and Off
   (Meet: Settings > Audio > Noise cancellation).

If step 4 fails (A's status says "sent" but B hears nothing, or the status says "failed"), copy the diagnostics from
**Advanced settings** and see the fallback below. Please note which of those it was; it narrows the cause.

## Known limitations

- **Studio sound / noise cancellation.** Meet's "Studio sound" ("Filters out sound from your mic that isn't
  speech") and noise cancellation break up or remove music. By default MeetEntry briefly opens Meet's
  Settings > Audio, switches it off before the clip, and switches it back on afterwards (option "Switch off Meet's
  Studio sound while the clip plays"). This drives Meet's own UI, so it depends on Meet's English labels
  ("More options", "Settings", "Audio", "Studio sound") and **fails safe**: if anything is not found you get a notice
  and the clip still plays. If you leave the meeting mid-clip, Studio sound is restored at your next entry in that
  tab; if it ever stays off, turn it back on in Settings > Audio. You can disable the option and manage the Meet
  setting yourself. To help the clip survive Meet's voice codec it ducks your mic to ~30% while the
  clip plays, applies a high-pass filter, gentle compression and a presence boost to the clip, uses a soft
  limiter, and asks the browser for a higher outgoing audio bitrate (the browser may ignore this; the
  diagnostics show the target bitrate).
- **Muted = silent.** The clip travels in your microphone audio, so it only plays when you are unmuted. By
  design MeetEntry never un-mutes you.
- **Sender-side verification only.** The extension cannot see what remote participants hear.
- **Language.** The "Join now / Ask to join" and waiting-room hints are English only. They are cosmetic: entry
  detection relies on the language-independent leave icon plus the media connection.
- **Meet changes.** If Google changes Meet internals the extension fails safe (does nothing, leaves your mic
  untouched) rather than breaking the call. After an extension update, reload open Meet tabs.
- **One clip.** A single profile/clip for now; multiple local profiles are a future enhancement.
- **Chrome only** (Edge probably works as it is Chromium; not tested).

## Fallback: virtual audio device (if direct injection does not work in Meet)

Only needed if the two-participant test shows Meet ignores the swapped track. This fallback **does not use the
extension's injection**; it routes audio at the OS level and has different trade-offs:

1. Install [VB-CABLE](https://vb-audio.com/Cable/) (free) or VoiceMeeter.
2. Mix your voice into the cable so you can still talk: in Windows Sound settings open your real microphone's
   properties, tick **Listen to this device** and choose **CABLE Input** as the playback device. (VoiceMeeter can do
   the same mixing with more control.)
3. Play your entrance clip to **CABLE Input** at the moment you join, using a player or soundboard that lets you
   choose the output device (VLC, EXP Soundboard, etc.).
4. In Meet, choose **CABLE Output** (or the VoiceMeeter virtual output) as the microphone.

What needs the fallback: reaching other participants if injection fails. What does **not** need it: everything
else (detection, UI, preview, settings). Auto-triggering a player on join would be a separate helper process (not
part of this extension); the extension's status can tell you when you have entered.

## Privacy

- Audio files, settings, and the optional Gmail/display-name labels are stored only in this browser
  (`chrome.storage.local` and IndexedDB). Nothing is uploaded; there is no backend.
- Permission requested: `storage` only, plus content-script access to `https://meet.google.com/*`. No `tabs`,
  no OAuth, no Gmail access. The Gmail field is just a label.
- The extension never records meeting participants. It touches only your *outgoing* microphone sender, and only
  while the clip plays.
- Your microphone permission is Meet's, not ours: MeetEntry does not open a second microphone capture.

## Project layout

```
public/manifest.json         MV3 manifest (copied to dist/)
popup.html, options.html     UI entry pages
src/background/              service worker: serves clips to Meet tabs, keeps per-tab status
src/content/                 meeting detection, state machine, bridge client, toast, controller
src/injection/               MAIN-world: peer tracking, mic+clip mixer, bridge
src/audio/                   WAV helpers, envelope, preview player
src/storage/                 settings (chrome.storage) and clip storage (IndexedDB)
src/popup/, src/options/     React UI
src/types/                   validated message and bridge protocols
scripts/                     build, icons, zip, and browser-based verification scripts
tests/                       Vitest unit tests
```

Privileged code (service worker, storage) is separate from page-context code. The page script has no `chrome.*`
access and holds only the clip it is handed; the two talk over a private `MessageChannel` with validated messages.

## Publishing to the Chrome Web Store

1. `npm run package` produces `meetentry-<version>.zip` (manifest at the archive root).
2. Create a developer account at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   (one-time registration fee).
3. Upload the zip. Listing needs: 128 px icon (included), at least one 1280x800 or 640x400 screenshot
   (`npm run screenshots` gives a starting point), a short description, and a category.
4. **Single purpose:** "Play a user-chosen entrance sound when the user joins a Google Meet."
5. **Permission justification:** `storage` for settings; host access to `meet.google.com` to detect joining and send
   the clip through the user's own outgoing audio. No remote code, no data collection.
6. **Privacy practices:** declare *no user data collected or transmitted*; all data local. Host a short privacy policy
   page stating this (required for extensions that run on user-facing sites).
7. Expect the review to look closely at the page-context `RTCPeerConnection` hook. The bundles are intentionally
   unminified, and this README explains exactly what it does.
8. Bump `version` in `public/manifest.json` and `package.json` for each release.
9. Make sure listings and the README keep the claim honest: do not advertise "everyone hears it" until you have
   completed the two-participant test and noted any noise-cancellation caveats.
